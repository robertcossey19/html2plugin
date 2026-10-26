#include "JSHost.h"
#include <cstring>

// Glue evaluated after the engine. Everything the native side needs is reachable through the H2P object.
static const char* kGlue = R"JS(
var H2P = (function () {
  var ctx = null;
  return {
    init: function (sr, workletsCode, hostNamesJson) {
      ctx = new WebAudioEngine.Context(sr);
      ctx.addModule(workletsCode);
      ctx.setHostParamNames(JSON.parse(hostNamesJson));
      return Object.keys(WebAudioEngine.registry).length;
    },
    render: function (inL, inR, outL, outR, n, zl) { ctx.render(inL, inR, outL, outR, n, !!zl); },
    apply: function (s) { ctx.applyJSON(s); },
    drain: function (withAn) { return ctx.drainOutboxJSON(!!withAn); },
    hostParam: function (name, v) { return ctx.hostParam(name, v) ? 1 : 0; },
    errors: function () { var e = ctx ? ctx.errors.splice(0) : []; return JSON.stringify(e); },
    describe: function () { return ctx ? ctx.describeJSON() : '{}'; }
  };
})();
)JS";

JSHost::JSHost() {}
JSHost::~JSHost() { release(); }

void JSHost::release()
{
    if (ctx == nullptr) return;
    for (JSObjectRef* o : { &api, &fnRender, &fnApply, &fnDrain, &fnHostParam, &fnErrors, &fnDescribe, &taInL, &taInR, &taOutL, &taOutR })
        if (*o != nullptr) { JSValueUnprotect (ctx, *o); *o = nullptr; }
    JSGlobalContextRelease (ctx);
    ctx = nullptr; ready = false;
}

std::string JSHost::toStdString (JSValueRef v)
{
    if (v == nullptr) return {};
    JSValueRef exc = nullptr;
    JSStringRef s = JSValueToStringCopy (ctx, v, &exc);
    if (s == nullptr) return {};
    size_t max = JSStringGetMaximumUTF8CStringSize (s);
    std::string out (max, '\0');
    size_t n = JSStringGetUTF8CString (s, &out[0], max);
    out.resize (n > 0 ? n - 1 : 0);
    JSStringRelease (s);
    return out;
}

std::string JSHost::exceptionText (JSValueRef exc)
{
    if (exc == nullptr) return "unknown JS exception";
    std::string msg = toStdString (exc);
    if (JSValueIsObject (ctx, exc))
    {
        JSObjectRef o = JSValueToObject (ctx, exc, nullptr);
        JSStringRef k = JSStringCreateWithUTF8CString ("stack");
        JSValueRef st = JSObjectGetProperty (ctx, o, k, nullptr);
        JSStringRelease (k);
        if (st != nullptr && ! JSValueIsUndefined (ctx, st)) msg += "\n" + toStdString (st);
        k = JSStringCreateWithUTF8CString ("line");
        JSValueRef ln = JSObjectGetProperty (ctx, o, k, nullptr);
        JSStringRelease (k);
        if (ln != nullptr && JSValueIsNumber (ctx, ln)) msg += " (line " + std::to_string ((int) JSValueToNumber (ctx, ln, nullptr)) + ")";
    }
    return msg;
}

bool JSHost::evaluate (const std::string& code, const char* name, std::string& err)
{
    JSStringRef src = JSStringCreateWithUTF8CString (code.c_str());
    JSStringRef url = JSStringCreateWithUTF8CString (name);
    JSValueRef exc = nullptr;
    JSEvaluateScript (ctx, src, nullptr, url, 1, &exc);
    JSStringRelease (src); JSStringRelease (url);
    if (exc != nullptr) { err = std::string (name) + ": " + exceptionText (exc); return false; }
    return true;
}

JSObjectRef JSHost::getFunction (JSObjectRef obj, const char* name)
{
    JSStringRef k = JSStringCreateWithUTF8CString (name);
    JSValueRef v = JSObjectGetProperty (ctx, obj, k, nullptr);
    JSStringRelease (k);
    if (v == nullptr || ! JSValueIsObject (ctx, v)) return nullptr;
    JSObjectRef f = JSValueToObject (ctx, v, nullptr);
    if (f == nullptr || ! JSObjectIsFunction (ctx, f)) return nullptr;
    JSValueProtect (ctx, f);
    return f;
}

JSObjectRef JSHost::makeFloat32Array (std::vector<float>& storage)
{
    JSValueRef exc = nullptr;
    JSObjectRef ta = JSObjectMakeTypedArrayWithBytesNoCopy (ctx, kJSTypedArrayTypeFloat32Array, storage.data(),
                                                             storage.size() * sizeof (float), nullptr, nullptr, &exc);
    if (ta != nullptr) JSValueProtect (ctx, ta);
    return ta;
}

bool JSHost::init (double sampleRate, int maxBlockSize, const std::string& engineJs, const std::string& workletsJs,
                   const std::string& hostParamNamesJson, std::string& err)
{
    release();
    currentSampleRate = sampleRate; maxBlock = std::max (maxBlockSize, 128);
    ctx = JSGlobalContextCreate (nullptr);
    if (ctx == nullptr) { err = "JSGlobalContextCreate failed"; return false; }
    global = JSContextGetGlobalObject (ctx);

    if (! evaluate (engineJs, "engine.js", err)) return false;
    if (! evaluate (kGlue, "glue.js", err)) return false;

    JSStringRef k = JSStringCreateWithUTF8CString ("H2P");
    JSValueRef apiV = JSObjectGetProperty (ctx, global, k, nullptr);
    JSStringRelease (k);
    if (apiV == nullptr || ! JSValueIsObject (ctx, apiV)) { err = "H2P glue object missing"; return false; }
    api = JSValueToObject (ctx, apiV, nullptr); JSValueProtect (ctx, api);

    JSObjectRef fnInit = getFunction (api, "init");
    fnRender = getFunction (api, "render"); fnApply = getFunction (api, "apply"); fnDrain = getFunction (api, "drain");
    fnHostParam = getFunction (api, "hostParam"); fnErrors = getFunction (api, "errors"); fnDescribe = getFunction (api, "describe");
    if (! fnInit || ! fnRender || ! fnApply || ! fnDrain || ! fnHostParam || ! fnErrors) { err = "glue functions missing"; return false; }

    {
        JSStringRef w = JSStringCreateWithUTF8CString (workletsJs.c_str());
        JSStringRef h = JSStringCreateWithUTF8CString (hostParamNamesJson.c_str());
        JSValueRef args[3] = { JSValueMakeNumber (ctx, sampleRate), JSValueMakeString (ctx, w), JSValueMakeString (ctx, h) };
        JSValueRef exc = nullptr;
        JSValueRef r = JSObjectCallAsFunction (ctx, fnInit, api, 3, args, &exc);
        JSStringRelease (w); JSStringRelease (h);
        JSValueUnprotect (ctx, fnInit);
        if (exc != nullptr) { err = "engine init / worklet module: " + exceptionText (exc); return false; }
        if (r == nullptr || JSValueToNumber (ctx, r, nullptr) < 1) { err = "worklet module registered no processors"; return false; }
    }

    bInL.assign ((size_t) maxBlock, 0.f); bInR.assign ((size_t) maxBlock, 0.f); bOutL.assign ((size_t) maxBlock, 0.f); bOutR.assign ((size_t) maxBlock, 0.f);
    taInL = makeFloat32Array (bInL); taInR = makeFloat32Array (bInR); taOutL = makeFloat32Array (bOutL); taOutR = makeFloat32Array (bOutR);
    if (! taInL || ! taInR || ! taOutL || ! taOutR) { err = "typed array creation failed"; return false; }
    ready = true;
    return true;
}

void JSHost::render (const float* inL, const float* inR, float* outL, float* outR, int n, bool zeroLatency)
{
    if (! ready || n <= 0) return;
    if (n > maxBlock)
    {   // host lied about the max block: process in chunks (zero latency not possible unless chunks are multiples of 128)
        int done = 0;
        while (done < n) { int m = std::min (maxBlock, n - done); render (inL + done, inR + done, outL + done, outR + done, m, zeroLatency && (m % 128 == 0)); done += m; }
        return;
    }
    std::memcpy (bInL.data(), inL, sizeof (float) * (size_t) n);
    std::memcpy (bInR.data(), inR != nullptr ? inR : inL, sizeof (float) * (size_t) n);
    JSValueRef args[6] = { taInL, taInR, taOutL, taOutR, JSValueMakeNumber (ctx, n), JSValueMakeBoolean (ctx, zeroLatency) };
    JSValueRef exc = nullptr;
    JSObjectCallAsFunction (ctx, fnRender, api, 6, args, &exc);
    if (exc != nullptr)
    {   // never leave garbage on the bus
        noteException ("render", exc);
        std::memcpy (outL, inL, sizeof (float) * (size_t) n); if (outR) std::memcpy (outR, inR != nullptr ? inR : inL, sizeof (float) * (size_t) n);
        return;
    }
    std::memcpy (outL, bOutL.data(), sizeof (float) * (size_t) n);
    if (outR) std::memcpy (outR, bOutR.data(), sizeof (float) * (size_t) n);
}

void JSHost::applyOpsJSON (const std::string& opsJson)
{
    if (! ready) return;
    JSStringRef s = JSStringCreateWithUTF8CString (opsJson.c_str());
    JSValueRef args[1] = { JSValueMakeString (ctx, s) };
    JSValueRef exc = nullptr;
    JSObjectCallAsFunction (ctx, fnApply, api, 1, args, &exc);
    JSStringRelease (s);
    if (exc != nullptr) noteException ("apply", exc);
}

std::string JSHost::drainOutboxJSON (bool withAnalysers)
{
    if (! ready) return {};
    JSValueRef args[1] = { JSValueMakeBoolean (ctx, withAnalysers) };
    JSValueRef exc = nullptr;
    JSValueRef r = JSObjectCallAsFunction (ctx, fnDrain, api, 1, args, &exc);
    if (exc != nullptr || r == nullptr) return {};
    return toStdString (r);
}

int JSHost::hostParam (const std::string& name, double value)
{
    if (! ready) return 0;
    JSStringRef s = JSStringCreateWithUTF8CString (name.c_str());
    JSValueRef args[2] = { JSValueMakeString (ctx, s), JSValueMakeNumber (ctx, value) };
    JSValueRef exc = nullptr;
    JSValueRef r = JSObjectCallAsFunction (ctx, fnHostParam, api, 2, args, &exc);
    JSStringRelease (s);
    if (exc != nullptr) noteException ("hostParam", exc);
    if (exc != nullptr || r == nullptr) return 0;
    return (int) JSValueToNumber (ctx, r, nullptr);
}

std::string JSHost::takeErrors()
{
    if (! ready) return "[]";
    JSValueRef exc = nullptr;
    JSValueRef r = JSObjectCallAsFunction (ctx, fnErrors, api, 0, nullptr, &exc);
    if (exc != nullptr || r == nullptr) return "[]";
    return toStdString (r);
}

std::string JSHost::describe()
{
    if (! ready || fnDescribe == nullptr) return "{}";
    JSValueRef exc = nullptr;
    JSValueRef r = JSObjectCallAsFunction (ctx, fnDescribe, api, 0, nullptr, &exc);
    if (exc != nullptr || r == nullptr) return "{}";
    return toStdString (r);
}

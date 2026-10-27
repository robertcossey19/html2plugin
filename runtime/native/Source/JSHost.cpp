#include "JSHost.h"
#include <mutex>
#include <vector>
#include <cstring>
#include <cstdlib>
#include <algorithm>
#include <thread>
#include <deque>
#include <functional>
#include <condition_variable>
#if H2P_STATIC_JSC
 #include <dlfcn.h>
 #include <sys/mman.h>
 #include <pthread.h>
 #include <CoreFoundation/CoreFoundation.h>
 #if __has_include(<pthread/tsd_private.h>)
  #include <pthread/tsd_private.h>
  #define H2P_HAVE_TSD_DIRECT 1
 #endif
#endif

#if H2P_STATIC_JSC
// The engine is linked into this plugin binary. Two things follow:
//  * the image must never be unloaded (JSC keeps compiler/GC threads alive), so pin it the first time we run;
//  * JSC asserts if it cannot get MAP_JIT memory. Probe first; without it run the interpreter instead of crashing the host.
static bool setJit = false; static std::vector<std::string> setVars;
static void setIfUnset (const char* k, const char* v) { if (getenv (k) == nullptr) { setenv (k, v, 1); setVars.emplace_back (k); } }
static void forgetStaticJSCEnv() { if (setJit) unsetenv ("JSC_useJIT"); for (auto& k : setVars) unsetenv (k.c_str()); setJit = false; setVars.clear(); }
static const char* prepareStaticJSC (bool wantWasm)
{
    static const char* verdict = nullptr;
    if (verdict != nullptr) return verdict;
    Dl_info info {};
    if (dladdr ((void*) &prepareStaticJSC, &info) && info.dli_fname != nullptr)
        dlopen (info.dli_fname, RTLD_NOW | RTLD_NODELETE);          // handle intentionally kept: image stays mapped for the life of the process
    const size_t sz = 16384;
    void* p = mmap (nullptr, sz, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANON | MAP_JIT, -1, 0);
    const bool jitMem = p != MAP_FAILED;
    if (jitMem) munmap (p, sz);
    // JSC_* variables are read once, by the bundled engine's first VM init (inside JSGlobalContextCreate below); they are
    // removed again right after so the host's own copy of Apple's JavaScriptCore never sees them.
    if (! jitMem && getenv ("JSC_useJIT") == nullptr) { setenv ("JSC_useJIT", "false", 1); setJit = true; }
    // WebAssembly only for pages that ship a wasm DSP engine (manifest usesWasm). Plugins without wasm keep the exact JSC
    // configuration that has been validated (build 24): wasm off, default VM traps. With wasm on, inside somebody else's
    // process we must not install fault handlers: bounds-checked (non-fast) memories, no SIGBUS/SIGSEGV handler; without JIT
    // the wasm runs on IPInt.
    if (! wantWasm) setIfUnset ("JSC_useWasm", "false");
    else { setIfUnset ("JSC_useWasmFastMemory", "false"); setIfUnset ("JSC_useWasmFaultSignalHandler", "false"); }
    verdict = jitMem ? "bundled JavaScriptCore (static), MAP_JIT memory available in this host"
                     : "bundled JavaScriptCore (static), host forbids MAP_JIT memory -> interpreter";
    return verdict;
}
#endif

// Glue evaluated after the engine. Everything the native side needs is reachable through the H2P object.
static const char* kGlue = R"JS(
var H2P = (function () {
  var ctx = null;
  return {
    init: function (sr, workletsCode, hostNamesJson) {
      // Called again on every sample-rate / block change and for every plugin instance that reuses this slot: a fresh engine
      // Context, the worklet module re-evaluated (so module-level reads of `sampleRate` see the new rate, exactly like a new
      // AudioWorkletGlobalScope). The old graph becomes garbage. No global context is ever released and re-created (see
      // JSHost::init: that path tripped JavaScriptCore's atom-table assertion inside auval on the 7th rate change).
      ctx = null;
      for (var k in WebAudioEngine.registry) delete WebAudioEngine.registry[k];
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
    describe: function () { return ctx ? ctx.describeJSON() : '{}'; },
    jitProbe: function () {   // best of 4 runs so tier-up has happened and one preempted run can't masquerade as the interpreter
      var best = 1e9;
      for (var r = 0; r < 4; r++) { var t0 = Date.now(); var x = 0.1; for (var i = 0; i < 2000000; i++) { x = x * 0.9999999 + 0.000001; } var t = Date.now() - t0; if (x !== x) t = 1e9; if (t < best) best = t; }
      return best;
    }
  };
})();
)JS";

// VM pool. A JSC VM owns concurrent compiler and GC threads; tearing one down while a DFG/FTL plan for it is still in
// flight is a race we do not need to take inside somebody's DAW. Hosts call prepareToPlay with new rates/blocks
// dozens of times (pluginval: every rate x block combination), so VMs are created once per plugin instance slot and
// handed back to a free list instead of destroyed. A new global context inside an existing VM is the well-trodden
// WebKit path (every page load does it). One VM per concurrently alive instance keeps instances lock-free of each other.
static std::mutex& poolMutex() { static std::mutex m; return m; }
static std::vector<JSContextGroupRef>& freeGroups() { static std::vector<JSContextGroupRef> v; return v; }
static JSContextGroupRef acquireGroup()
{
    { std::lock_guard<std::mutex> lk (poolMutex()); auto& f = freeGroups(); if (! f.empty()) { JSContextGroupRef g = f.back(); f.pop_back(); return g; } }
    return JSContextGroupCreate();
}
static void returnGroup (JSContextGroupRef g) { if (g == nullptr) return; std::lock_guard<std::mutex> lk (poolMutex()); freeGroups().push_back (g); }


// ---------------------------------------------------------------------------------------------------------------------
// Thread policy for the bundled engine.
// Apple's JavaScriptCore/WebKit (mapped into this process by the editor's WKWebView, and by most DAWs on their own) and the
// engine linked into this binary are two separate copies of WTF. Both keep the per-thread WTF::Thread object in the same fixed
// pthread TSD slot (__PTK_FRAMEWORK_JAVASCRIPTCORE_KEY2, see wtf/FastTLS.h: "WTF_THREAD_DATA_KEY"), and neither can tell the
// other's object from its own. Whichever copy initialises a thread first owns the slot; the other then reads a foreign object
// through its own struct layout. Seen in auval (builds 30/32/34/35): RELEASE_ASSERT in JSC::Heap::collect, atom-table mismatch,
// the first time our GC ran on the host's main thread after WebKit had been used there. Rule, enforced below:
//   * the bundled engine never runs on the process main thread (WebKit lives there in every host and in auval);
//   * any other thread is clean iff the slot is still empty the first time this code sees it — true for every DAW audio thread,
//     which is where render() is called, so the real-time path stays a direct call with no hop;
//   * work arriving on an unclean thread is executed synchronously on a private engine thread ("h2p-js") that runs a CFRunLoop
//     (so JavaScriptCore's own GC/sweeper timers fire there) and never touches WebKit. The VM is always created on that thread.
// With Apple's framework instead of the bundled engine there is only one WTF and every thread is clean.
#if H2P_STATIC_JSC
static bool currentThreadCleanForBundledJSC()
{
    enum : int { Unknown = 0, Clean = 1, Foreign = 2 };
    static thread_local int state = Unknown;
    if (state == Unknown)
    {
        if (pthread_main_np() != 0) state = Foreign;
        else
        {
           #if H2P_HAVE_TSD_DIRECT
            state = _pthread_getspecific_direct (__PTK_FRAMEWORK_JAVASCRIPTCORE_KEY2) == nullptr ? Clean : Foreign;
           #else
            state = pthread_getspecific ((pthread_key_t) 92) == nullptr ? Clean : Foreign;   // 92 == __PTK_FRAMEWORK_JAVASCRIPTCORE_KEY2
           #endif
        }
    }
    return state == Clean;
}

struct JSHost::Worker
{
    pthread_t th {}; bool haveThread = false;
    CFRunLoopRef rl = nullptr;
    CFRunLoopSourceRef src = nullptr;
    std::mutex m; std::condition_variable cv;
    bool started = false, stopping = false;
    std::deque<std::function<void()>> jobs;

    Worker()
    {
        pthread_attr_t attr; pthread_attr_init (&attr);
        pthread_attr_setstacksize (&attr, 8u << 20);   // same 8 MB a main thread gets: deep worklet init code / JSC parser recursion must not hit a 512 KB std::thread stack
        haveThread = pthread_create (&th, &attr, [] (void* p) -> void* { static_cast<Worker*> (p)->loop(); return nullptr; }, this) == 0;
        pthread_attr_destroy (&attr);
        if (! haveThread) return;
        std::unique_lock<std::mutex> lk (m); cv.wait (lk, [this] { return started; });
    }
    ~Worker()
    {
        { std::lock_guard<std::mutex> lk (m); stopping = true; }
        if (rl != nullptr) CFRunLoopStop (rl);
        if (haveThread) pthread_join (th, nullptr);
        if (src != nullptr) CFRelease (src);
        if (rl != nullptr) CFRelease (rl);
    }
    bool onWorkerThread() const { return haveThread && pthread_equal (pthread_self(), th) != 0; }
    static void perform (void* info) { static_cast<Worker*> (info)->drain(); }
    void drain()
    {
        for (;;)
        {
            std::function<void()> job;
            { std::lock_guard<std::mutex> lk (m); if (jobs.empty()) return; job = std::move (jobs.front()); jobs.pop_front(); }
            job();
        }
    }
    void loop()
    {
        pthread_setname_np ("h2p-js");
        pthread_set_qos_class_self_np (QOS_CLASS_USER_INTERACTIVE, 0);
        rl = CFRunLoopGetCurrent(); CFRetain (rl);
        CFRunLoopSourceContext c {}; c.info = this; c.perform = &Worker::perform;
        src = CFRunLoopSourceCreate (kCFAllocatorDefault, 0, &c);
        CFRunLoopAddSource (rl, src, kCFRunLoopDefaultMode);
        { std::lock_guard<std::mutex> lk (m); started = true; } cv.notify_all();
        for (;;)
        {
            { std::lock_guard<std::mutex> lk (m); if (stopping) break; }
            CFRunLoopRun();
        }
        drain();
    }
    struct Ticket { std::mutex m; std::condition_variable cv; bool done = false; };
    void runSync (const std::function<void()>& f)
    {
        // The completion handshake lives on the heap and is co-owned by the job: the caller's frame may be gone by the time
        // the engine thread leaves notify_all() (a stack-resident ticket smashed the caller's stack in build-37, and hung
        // build-36). Notify under the lock so the waiter cannot run ahead of the signaller either.
        auto t = std::make_shared<Ticket>();
        { std::lock_guard<std::mutex> lk (m); jobs.push_back ([&f, t] { f(); std::lock_guard<std::mutex> l2 (t->m); t->done = true; t->cv.notify_all(); }); }
        CFRunLoopSourceSignal (src); CFRunLoopWakeUp (rl);
        std::unique_lock<std::mutex> lk (t->m); t->cv.wait (lk, [&] { return t->done; });
    }
};

bool JSHost::threadClean() { return currentThreadCleanForBundledJSC(); }
void JSHost::runOnWorker (const std::function<void()>& f)
{
    if (worker != nullptr && worker->onWorkerThread()) { f(); return; }
    if (worker == nullptr) worker.reset (new Worker());
    if (! worker->haveThread) { f(); return; }   // could not create the thread (should not happen): run inline rather than silence the plugin
    worker->runSync (f);
}
#else
struct JSHost::Worker {};
bool JSHost::threadClean() { return true; }
void JSHost::runOnWorker (const std::function<void()>& f) { f(); }
#endif
// ---------------------------------------------------------------------------------------------------------------------

JSHost::JSHost() {}
JSHost::~JSHost() { if (ctx != nullptr || group != nullptr) run ([this] { release(); returnGroup (group); group = nullptr; }, true); worker.reset(); }

// Host pool: a JSHost (VM + global context + evaluated engine) is never destroyed while the process lives; a processor that
// goes away hands its host back and the next processor re-initialises it in place. Contexts are therefore created exactly once
// per concurrently alive instance slot.
static std::vector<std::unique_ptr<JSHost>>& freeHosts() { static auto* v = new std::vector<std::unique_ptr<JSHost>>(); return *v; }   // intentionally never destroyed: no JSC teardown during process exit
std::unique_ptr<JSHost> JSHost::acquire()
{
    std::lock_guard<std::mutex> lk (poolMutex()); auto& f = freeHosts();
    if (! f.empty()) { auto h = std::move (f.back()); f.pop_back(); return h; }
    return std::unique_ptr<JSHost> (new JSHost());
}
void JSHost::recycle (std::unique_ptr<JSHost> h)
{
    if (! h) return;
    h->ready = false; h->nativeErrors.clear();
    std::lock_guard<std::mutex> lk (poolMutex()); freeHosts().push_back (std::move (h));
}

void JSHost::release()
{
    if (ctx == nullptr) return;
    for (JSObjectRef* o : { &api, &fnRender, &fnApply, &fnDrain, &fnHostParam, &fnErrors, &fnDescribe, &taInL, &taInR, &taOutL, &taOutR })
        if (*o != nullptr) { JSValueUnprotect (ctx, *o); *o = nullptr; }
    JSGlobalContextRelease (ctx);
    ctx = nullptr; ready = false;
}

// Drop the per-init JS references (typed arrays, functions) but keep the context alive for re-initialisation.
void JSHost::dropInitRefs()
{
    if (ctx == nullptr) return;
    for (JSObjectRef* o : { &api, &fnRender, &fnApply, &fnDrain, &fnHostParam, &fnErrors, &fnDescribe, &taInL, &taInR, &taOutL, &taOutR })
        if (*o != nullptr) { JSValueUnprotect (ctx, *o); *o = nullptr; }
    ready = false;
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
                   const std::string& hostParamNamesJson, std::string& err, bool wantWasm)
{   // always on the engine thread: the VM (and its run loop, which carries JSC's GC timers) is born there
    bool ok = false;
    run ([&] { ok = initImpl (sampleRate, maxBlockSize, engineJs, workletsJs, hostParamNamesJson, err, wantWasm); }, true);
    return ok;
}

bool JSHost::initImpl (double sampleRate, int maxBlockSize, const std::string& engineJs, const std::string& workletsJs,
                       const std::string& hostParamNamesJson, std::string& err, bool wantWasm)
{
    dropInitRefs();
    currentSampleRate = sampleRate; maxBlock = std::max (maxBlockSize, 128);
    const bool fresh = (ctx == nullptr);
    if (fresh)
    {
       #if H2P_STATIC_JSC
        engineInfo = prepareStaticJSC (wantWasm);
       #else
        engineInfo = "Apple JavaScriptCore.framework (JIT only when the host process carries com.apple.security.cs.allow-jit)";
       #endif
        if (group == nullptr) group = acquireGroup();   // JSC_* env is read here, by the first VM init in the process
       #if H2P_STATIC_JSC
        forgetStaticJSCEnv();
       #endif
        if (group == nullptr) { err = "JSContextGroupCreate failed"; return false; }
        ctx = JSGlobalContextCreateInGroup (group, nullptr);
        if (ctx == nullptr) { err = "JSGlobalContextCreateInGroup failed"; return false; }
        global = JSContextGetGlobalObject (ctx);
        if (! evaluate (engineJs, "engine.js", err)) return false;
        if (! evaluate (kGlue, "glue.js", err)) return false;
    }
    else if (engineJs != loadedEngineJs)
    {   // a different plugin's engine in a recycled slot cannot happen (one binary = one engine), but never run the wrong code silently
        err = "recycled JS context carries a different engine"; return false;
    }
    loadedEngineJs = engineJs;

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
    if (JSObjectRef fnProbe = getFunction (api, "jitProbe"))
    {
        JSValueRef exc = nullptr; JSValueRef r = JSObjectCallAsFunction (ctx, fnProbe, api, 0, nullptr, &exc);
        if (exc == nullptr && r != nullptr) jitProbeMs = JSValueToNumber (ctx, r, nullptr);
        JSValueUnprotect (ctx, fnProbe);
    }
    return true;
}

void JSHost::render (const float* inL, const float* inR, float* outL, float* outR, int n, bool zeroLatency)
{
    if (! ready || n <= 0) return;
    run ([&] { renderImpl (inL, inR, outL, outR, n, zeroLatency); });   // direct call on a clean audio thread; a hop only on WebKit-touched threads (auval renders on main)
}

void JSHost::renderImpl (const float* inL, const float* inR, float* outL, float* outR, int n, bool zeroLatency)
{
    if (n > maxBlock)
    {   // host lied about the max block: process in chunks (zero latency not possible unless chunks are multiples of 128)
        int done = 0;
        while (done < n) { int m = std::min (maxBlock, n - done); renderImpl (inL + done, inR + done, outL + done, outR + done, m, zeroLatency && (m % 128 == 0)); done += m; }
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
    run ([&] { applyOpsJSONImpl (opsJson); });
}
void JSHost::applyOpsJSONImpl (const std::string& opsJson)
{
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
    std::string r; run ([&] { r = drainOutboxJSONImpl (withAnalysers); }); return r;
}
std::string JSHost::drainOutboxJSONImpl (bool withAnalysers)
{
    JSValueRef args[1] = { JSValueMakeBoolean (ctx, withAnalysers) };
    JSValueRef exc = nullptr;
    JSValueRef r = JSObjectCallAsFunction (ctx, fnDrain, api, 1, args, &exc);
    if (exc != nullptr || r == nullptr) return {};
    return toStdString (r);
}

int JSHost::hostParam (const std::string& name, double value)
{
    if (! ready) return 0;
    int r = 0; run ([&] { r = hostParamImpl (name, value); }); return r;
}
int JSHost::hostParamImpl (const std::string& name, double value)
{
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
    std::string r; run ([&] { r = takeErrorsImpl(); }); return r;
}
std::string JSHost::takeErrorsImpl()
{
    JSValueRef exc = nullptr;
    JSValueRef r = JSObjectCallAsFunction (ctx, fnErrors, api, 0, nullptr, &exc);
    if (exc != nullptr || r == nullptr) return "[]";
    return toStdString (r);
}

std::string JSHost::describe()
{
    if (! ready || fnDescribe == nullptr) return "{}";
    std::string r; run ([&] { r = describeImpl(); }); return r;
}
std::string JSHost::describeImpl()
{
    JSValueRef exc = nullptr;
    JSValueRef r = JSObjectCallAsFunction (ctx, fnDescribe, api, 0, nullptr, &exc);
    if (exc != nullptr || r == nullptr) return "{}";
    return toStdString (r);
}

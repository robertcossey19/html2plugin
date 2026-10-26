// JSHost — runs engine/webaudio-engine.js + the page's untouched AudioWorklet module(s) inside Apple's JavaScriptCore.
// One instance per processor; all calls after init() happen on the audio thread (JSC takes its own VM lock per call).
#pragma once
#include <string>
#include <vector>
#include <JavaScriptCore/JavaScript.h>   // C API only: present in Apple's framework and in the statically linked open-source build

class JSHost
{
public:
    JSHost();
    ~JSHost();

    // Evaluates engine + glue + worklet modules and creates the engine Context. Returns false (and fills err) on failure.
    bool init (double sampleRate, int maxBlockSize, const std::string& engineJs, const std::string& workletsJs,
               const std::string& hostParamNamesJson, std::string& err);

    // Process n frames (n <= maxBlockSize). zeroLatency only when every block is a multiple of 128.
    void render (const float* inL, const float* inR, float* outL, float* outR, int n, bool zeroLatency);

    void applyOpsJSON (const std::string& opsJson);                 // RPC ops recorded by the WebView shim (JSON array)
    std::string drainOutboxJSON (bool withAnalysers);               // {time, msgs:[{id,data}], analysers?}
    int hostParam (const std::string& name, double value);          // 0 = no such param, 1 = applied
    std::string describe();                                         // JSON snapshot of the live graph (diagnostics; not RT-safe)
    std::string takeErrors();                                       // JSON array of engine error strings (empties the list)
    std::vector<std::string> takeNativeErrors() { std::vector<std::string> v; v.swap (nativeErrors); return v; } // exceptions thrown out of apply/render/hostParam

    bool isReady() const { return ready; }
    std::string engineInfo;          // which JavaScriptCore this is and whether JIT memory was obtainable in this host process
    double jitProbeMs = -1;          // ms for a 2e6-iteration float loop measured inside this context right after init (FTL JIT: a few ms; LLInt interpreter: 100+ ms)
    bool jitLikelyOn() const { return jitProbeMs >= 0 && jitProbeMs < 20.0; }   // measured on CI M1: FTL/DFG 5-12 ms (best of 4), LLInt interpreter ~30 ms; 20 ms splits the gap
    double currentSampleRate = 0;
    int maxBlock = 0;

private:
    JSGlobalContextRef ctx = nullptr;
    JSObjectRef global = nullptr, api = nullptr;
    JSObjectRef fnRender = nullptr, fnApply = nullptr, fnDrain = nullptr, fnHostParam = nullptr, fnErrors = nullptr, fnDescribe = nullptr;
    JSObjectRef taInL = nullptr, taInR = nullptr, taOutL = nullptr, taOutR = nullptr;
    std::vector<float> bInL, bInR, bOutL, bOutR;
    bool ready = false;
    std::vector<std::string> nativeErrors;
    void noteException (const char* where, JSValueRef exc) { if (nativeErrors.size() < 32) nativeErrors.push_back (std::string (where) + ": " + exceptionText (exc)); }

    bool evaluate (const std::string& code, const char* name, std::string& err);
    JSObjectRef getFunction (JSObjectRef obj, const char* name);
    std::string toStdString (JSValueRef v);
    std::string exceptionText (JSValueRef exc);
    JSObjectRef makeFloat32Array (std::vector<float>& storage);
    void release();
};

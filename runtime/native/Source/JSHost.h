// JSHost — runs engine/webaudio-engine.js + the page's untouched AudioWorklet module(s) inside Apple's JavaScriptCore.
// One instance per processor; all calls after init() happen on the audio thread (JSC takes its own VM lock per call).
#pragma once
#include <string>
#include <vector>
#include <JavaScriptCore/JavaScriptCore.h>

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
    std::string takeErrors();                                       // JSON array of engine error strings (empties the list)

    bool isReady() const { return ready; }
    double currentSampleRate = 0;
    int maxBlock = 0;

private:
    JSGlobalContextRef ctx = nullptr;
    JSObjectRef global = nullptr, api = nullptr;
    JSObjectRef fnRender = nullptr, fnApply = nullptr, fnDrain = nullptr, fnHostParam = nullptr, fnErrors = nullptr;
    JSObjectRef taInL = nullptr, taInR = nullptr, taOutL = nullptr, taOutR = nullptr;
    std::vector<float> bInL, bInR, bOutL, bOutR;
    bool ready = false;

    bool evaluate (const std::string& code, const char* name, std::string& err);
    JSObjectRef getFunction (JSObjectRef obj, const char* name);
    std::string toStdString (JSValueRef v);
    std::string exceptionText (JSValueRef exc);
    JSObjectRef makeFloat32Array (std::vector<float>& storage);
    void release();
};

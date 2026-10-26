// html2plugin HostTest: black-box test of the compiled VST3 through a real JUCE host.
//  * parameter table matches the manifest, every parameter sweep stays finite, state recall works
//  * golden master: the plugin (JavaScriptCore) must match the same engine + worklet run under Node/V8 (golden.json from tests/golden.js)
//  * CPU: render cost as % of realtime (run twice in CI: default and JSC_useJIT=false)
//  * --editor: opens the WebView UI with audio running and checks the page booted its graph (ops reached the engine)
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_gui_extra/juce_gui_extra.h>
#include "BinaryData.h"
#include <cmath>
#include <complex>
#include <cstdio>
#include <chrono>

static int failures = 0;
#define CHECK(cond, ...) do { if (cond) { printf ("  PASS  "); } else { ++failures; printf ("  FAIL  "); } printf (__VA_ARGS__); printf ("\n"); } while (0)

static juce::String asset (const char* name)
{
    for (int i = 0; i < BinaryData::namedResourceListSize; ++i)
        if (juce::String (BinaryData::originalFilenames[i]) == name) { int sz = 0; auto* d = BinaryData::getNamedResource (BinaryData::namedResourceList[i], sz); return juce::String::fromUTF8 (d, sz); }
    return {};
}

struct Host
{
    std::unique_ptr<juce::AudioPluginInstance> plug; double fs = 48000; int block = 512; double lastRenderSeconds = 0;
    juce::AudioProcessorParameter* byId (const juce::String& id) { for (auto* p : plug->getParameters()) if (auto* r = dynamic_cast<juce::RangedAudioParameter*> (p)) if (r->paramID == id) return p; return nullptr; }
    std::vector<float> run (double f0, double dbfs, double secs, bool silence = false)
    {
        int total = (int) (fs * secs); std::vector<float> out; out.reserve ((size_t) total);
        juce::AudioBuffer<float> buf (2, block); juce::MidiBuffer midi; double ph = 0, a = std::pow (10.0, dbfs / 20);
        auto t0 = std::chrono::steady_clock::now();
        for (int done = 0; done < total; done += block)
        {
            for (int n = 0; n < block; n++) { float s = silence ? 0.f : (float) (a * std::sin (ph)); ph += 2 * M_PI * f0 / fs; buf.setSample (0, n, s); buf.setSample (1, n, s); }
            plug->processBlock (buf, midi);
            for (int n = 0; n < block; n++) out.push_back (buf.getSample (0, n));
        }
        lastRenderSeconds = std::chrono::duration<double> (std::chrono::steady_clock::now() - t0).count();
        return out;
    }
};
static std::vector<float> tail (const std::vector<float>& y, size_t n) { return { y.end() - (long) n, y.end() }; }
static double rmsDb (const std::vector<float>& y) { double s = 0; for (float v : y) s += v * v; return 20 * std::log10 (std::sqrt (s / y.size()) + 1e-30); }
static bool finite (const std::vector<float>& y) { for (float v : y) if (! std::isfinite (v)) return false; return true; }
static double mag (const std::vector<float>& y, double fs, double f) { std::complex<double> acc = 0; size_t N = y.size(); for (size_t n = 0; n < N; n++) { double w = 0.5 - 0.5 * std::cos (2 * M_PI * n / (N - 1)); acc += y[n] * w * std::exp (std::complex<double> (0, -2 * M_PI * f * n / fs)); } return std::abs (acc); }
static double thdPct (const std::vector<float>& y, double fs, double f0) { double fund = mag (y, fs, f0), h = 0; for (int k = 2; k <= 10; k++) if (f0 * k < fs / 2) { double m = mag (y, fs, f0 * k); h += m * m; } return 100.0 * std::sqrt (h) / fund; }

int main (int argc, char** argv)
{
    setvbuf (stdout, nullptr, _IONBF, 0);
    if (argc < 2) { printf ("usage: HostTest path/to/Plugin.vst3 [--editor] [--golden golden.json]\n"); return 2; }
    bool testEditor = false; juce::String goldenPath;
    for (int i = 2; i < argc; ++i) { juce::String a (argv[i]); if (a == "--editor") testEditor = true; else if (a == "--golden" && i + 1 < argc) goldenPath = argv[++i]; }
    juce::ScopedJuceInitialiser_GUI gui; juce::MessageManager::getInstance()->setCurrentThreadAsMessageThread();
    const juce::var manifest = juce::JSON::parse (asset ("manifest.json"));
    const int expectedParams = manifest["params"].getArray() ? manifest["params"].getArray()->size() : 0;

    juce::AudioPluginFormatManager fm; fm.addDefaultFormats();
    juce::OwnedArray<juce::PluginDescription> descs; juce::KnownPluginList kpl;
    for (auto* f : fm.getFormats()) kpl.scanAndAddFile (argv[1], true, descs, *f);
    printf ("== Load ==\n"); CHECK (descs.size() > 0, "plugin scanned: %d description(s)", descs.size()); if (descs.isEmpty()) return 1;
    Host h; juce::String err; h.plug = fm.createPluginInstance (*descs[0], h.fs, h.block, err);
    CHECK (h.plug != nullptr, "instantiate: %s", err.isEmpty() ? "ok" : err.toRawUTF8()); if (! h.plug) return 1;
    h.plug->enableAllBuses(); h.plug->setPlayConfigDetails (2, 2, h.fs, h.block); h.plug->prepareToPlay (h.fs, h.block);
    printf ("     name: %s  latency: %d samples\n", h.plug->getName().toRawUTF8(), h.plug->getLatencySamples());
    CHECK (h.plug->getLatencySamples() == 0, "zero latency at block %d (multiple of 128)", h.block);

    printf ("== Parameters (%d) ==\n", h.plug->getParameters().size());
    CHECK (h.plug->getParameters().size() == expectedParams, "manifest lists %d parameters", expectedParams);
    for (auto* p : h.plug->getParameters()) printf ("     %-24s = %s\n", p->getName (32).toRawUTF8(), p->getCurrentValueAsText().toRawUTF8());

    printf ("== Default state: finite output, sane level ==\n");
    double defaultDb = 0, defaultThd = 0;
    { auto y = tail (h.run (1000, -20, 1.0), 16384); CHECK (finite (y), "no NaN/Inf at defaults"); defaultDb = rmsDb (y); defaultThd = thdPct (y, h.fs, 1000); CHECK (defaultDb > -80 && defaultDb < 0, "1 kHz -20 dBFS -> %.2f dBFS rms, THD %.3f %%", defaultDb, defaultThd);
      printf ("     render cost: %.1f %% of realtime (JavaScriptCore in this process%s)\n", 100.0 * h.lastRenderSeconds / 1.0, getenv ("JSC_useJIT") ? ", JSC_useJIT env set" : ""); }

    printf ("== Golden master vs Node/V8 ==\n");
    if (goldenPath.isNotEmpty())
    {
        auto g = juce::JSON::parse (juce::File::getCurrentWorkingDirectory().getChildFile (goldenPath));
        if (g.isObject())
        {
            double gDb = (double) g["outputDbfs"], gThd = (double) g["thdPct"];
            CHECK (std::abs (gDb - defaultDb) < 0.5, "level: plugin %.2f dBFS vs Node %.2f dBFS (|d| < 0.5 dB)", defaultDb, gDb);
            CHECK (gThd < 0.05 ? defaultThd < 0.1 : std::abs (defaultThd - gThd) / gThd < 0.25, "THD: plugin %.3f %% vs Node %.3f %% (within 25 %%)", defaultThd, gThd);
            if (auto* sweep = g["sweep"].getArray())
                for (auto& pt : *sweep)
                {   // {id, value, outputDbfs}
                    auto* p = h.byId (pt["id"].toString()); if (! p) continue; float keep = p->getValue();
                    if (auto* r = dynamic_cast<juce::RangedAudioParameter*> (p)) r->setValueNotifyingHost (r->convertTo0to1 ((float) (double) pt["value"]));
                    auto y = tail (h.run (1000, -20, 0.8), 16384); double db = rmsDb (y);
                    CHECK (std::abs (db - (double) pt["outputDbfs"]) < 0.5, "%s = %s: plugin %.2f vs Node %.2f dBFS", pt["id"].toString().toRawUTF8(), pt["value"].toString().toRawUTF8(), db, (double) pt["outputDbfs"]);
                    p->setValueNotifyingHost (keep); h.run (1000, -20, 0.3);
                }
        }
        else printf ("     golden file not readable: %s\n", goldenPath.toRawUTF8());
    }
    else printf ("     (no --golden file given)\n");

    printf ("== Every parameter: full sweep stays finite ==\n");
    for (auto* p : h.plug->getParameters())
    {
        float keep = p->getValue(); double ref = rmsDb (tail (h.run (1000, -20, 0.3), 8192)); double maxDelta = 0; bool ok = true;
        for (float n : { 0.0f, 0.5f, 1.0f }) { p->setValueNotifyingHost (n); auto y = tail (h.run (1000, -20, 0.3), 8192); ok = ok && finite (y); maxDelta = std::max (maxDelta, std::abs (rmsDb (y) - ref)); }
        p->setValueNotifyingHost (keep); h.run (1000, -20, 0.2);
        CHECK (ok, "%-24s finite across sweep (max level change %.2f dB%s)", p->getName (32).toRawUTF8(), maxDelta, maxDelta < 0.05 ? " — no level effect at 1 kHz" : "");
    }

    printf ("== State save/restore ==\n");
    if (h.plug->getParameters().size() > 0)
    {
        auto* p = h.plug->getParameters()[0]; float keep = p->getValue(); p->setValueNotifyingHost (0.731f); juce::MemoryBlock mb; h.plug->getStateInformation (mb);
        p->setValueNotifyingHost (keep); h.plug->setStateInformation (mb.getData(), (int) mb.getSize());
        CHECK (std::abs (p->getValue() - 0.731f) < 0.02f, "preset recall restores %s (%.3f)", p->getName (32).toRawUTF8(), p->getValue()); p->setValueNotifyingHost (keep);
    }

    printf ("== Odd block size: 480 frames -> latency reported ==\n");
    { h.plug->prepareToPlay (h.fs, 480); int keepBlock = h.block; h.block = 480; auto y = tail (h.run (1000, -20, 0.5), 8192); CHECK (finite (y) && rmsDb (y) > -80, "finite output at block 480 (%.2f dBFS), latency now %d", rmsDb (y), h.plug->getLatencySamples()); h.block = keepBlock; h.plug->prepareToPlay (h.fs, h.block); }

    if (testEditor)
    {
        printf ("== Editor ==\n");
        std::unique_ptr<juce::AudioProcessorEditor> ed (h.plug->createEditorIfNeeded());
        CHECK (ed != nullptr, "editor created (%dx%d)", ed ? ed->getWidth() : 0, ed ? ed->getHeight() : 0);
        if (ed)
        {
            juce::DocumentWindow win (H2P_TARGET_NAME, juce::Colours::black, juce::DocumentWindow::allButtons);
            win.setContentNonOwned (ed.get(), true); win.setVisible (true); win.toFront (true);
            for (int i = 0; i < 16; i++) { juce::MessageManager::getInstance()->runDispatchLoopUntil (500); h.run (1000, -20, 0.1); }
            auto y = tail (h.run (1000, -20, 0.5), 16384);
            CHECK (finite (y) && rmsDb (y) > -80, "audio still finite with the web UI open 8 s (%.2f dBFS)", rmsDb (y));
            CHECK (std::abs (rmsDb (y) - defaultDb) < 1.0, "level with UI-built graph %.2f dBFS matches boot-replay graph %.2f dBFS (page graph == captured graph)", rmsDb (y), defaultDb);
            win.clearContentComponent(); h.plug->editorBeingDeleted (ed.get()); ed.reset(); juce::MessageManager::getInstance()->runDispatchLoopUntil (300);
            auto y2 = tail (h.run (1000, -20, 0.5), 16384);
            CHECK (finite (y2) && std::abs (rmsDb (y2) - defaultDb) < 1.0, "after closing the editor the DSP keeps running (%.2f dBFS)", rmsDb (y2));
        }
    }
    h.plug->releaseResources(); h.plug.reset();
    printf ("\n%s (%d failure%s)\n", failures == 0 ? "ALL PASSED" : "FAILED", failures, failures == 1 ? "" : "s");
    return failures == 0 ? 0 : 1;
}

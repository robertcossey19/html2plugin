// Generic html2plugin processor: hosts the page's AudioWorklet (via JSHost/JavaScriptCore), exposes the page's parameters to the DAW,
// and shuttles Web Audio RPC ops (UI -> DSP) and worklet messages (DSP -> UI) between the WebView and the engine.
#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <memory>
#include <atomic>
#include <vector>
#include <string>
#include <functional>
#include "JSHost.h"

struct H2PParamDef
{
    juce::String id, name, type;        // type: float | bool | choice
    double min = 0, max = 1, def = 0, step = 0;
    std::vector<std::pair<juce::String, double>> choices;  // label, engineering value
    bool bound = false;
};

class H2PProcessor : public juce::AudioProcessor, private juce::Timer
{
public:
    H2PProcessor();
    ~H2PProcessor() override;

    // ---- AudioProcessor ----
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }
    const juce::String getName() const override { return pluginName; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.5; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}
    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    // ---- bridge used by the editor (message thread) ----
    void enqueueOps (const std::string& opsJson);                         // from the WebView shim
    void markPageLoading();                                               // a fresh page is booting: ignore its default values until synced
    void markPageSynced();                                                // host values have been pushed into the page
    std::string hostValuesJSON() const;                                   // {"id": engineeringValue, ...} for applyHostParams
    bool takeDirtyHostParams (std::string& json);                         // host/automation changes not yet shown in the UI
    int graphGeneration() const { return generation.load(); }            // bumps when the engine is rebuilt (editor must reload the page)
    void setEditorOpen (bool open) { editorOpen.store (open); }
    std::function<void (const std::string&)> onOutbox;                    // raw outbox JSON for the page (set/cleared by the editor)
    juce::String lastEngineError;                                         // for display/logging

    const juce::var& getManifest() const { return manifest; }
    const std::vector<H2PParamDef>& paramDefs() const { return defs; }
    juce::AudioProcessorValueTreeState& state() { return apvts; }

    static juce::String assetString (const char* name);                  // BinaryData lookup by original filename
    static void log (const juce::String& line);                          // stderr + ~/Library/Logs/html2plugin/<target>.log (Release builds included)

private:
    // NOTE: everything loadManifest() fills must be declared BEFORE apvts — buildLayout() runs inside apvts's
    // initialiser, and any member declared after apvts would be default-constructed afterwards (wiping it).
    juce::var manifest;
    juce::String pluginName;
    std::vector<H2PParamDef> defs;
    std::string engineJs, workletsJs, bootOpsJson, hostNamesJson;
    std::vector<juce::RangedAudioParameter*> params;
    juce::AudioProcessorValueTreeState apvts;

    std::unique_ptr<JSHost> js;
    double preparedRate = 0; int preparedBlock = 0;
    bool zeroLatency = false;
    std::atomic<int> generation { 0 };
    std::atomic<bool> editorOpen { false }, pageLoading { false };
    int reapplyBlocks = 0, drainCountdown = 0, drainEvery = 8, clockTick = 0;

    // UI -> audio ops and audio -> UI outbox (both message-thread pushed / audio-thread try-locked)
    juce::SpinLock opsLock, outLock;
    std::vector<std::string> opsPending, opsWorking, outPending;

    std::unique_ptr<std::atomic<double>[]> lastApplied, hostPush;
    std::unique_ptr<std::atomic<bool>[]> dirty;
    std::unique_ptr<std::atomic<juce::uint32>[]> hostSetMs;

    juce::AudioProcessorValueTreeState::ParameterLayout buildLayout();
    void loadManifest();
    double engineeringValue (int i) const;                                // current host value in page units
    void setFromEngineering (int i, double v);                            // page -> host
    void rebuildEngine (double sr, int block);
    void applyAllHostParams();
    void flushEngineErrors (const char* stage);                           // message/prepare thread only
    void timerCallback() override;                                        // message thread: outbox dispatch
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (H2PProcessor)
};

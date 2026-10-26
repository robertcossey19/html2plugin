#include "PluginProcessor.h"
#include "PluginEditor.h"
#include "BinaryData.h"
#include <iostream>

void H2PProcessor::log (const juce::String& line)
{
    std::cerr << "[h2p " << H2P_TARGET_NAME << "] " << line << std::endl;
    static juce::File logFile = juce::File::getSpecialLocation (juce::File::userHomeDirectory).getChildFile ("Library/Logs/html2plugin").getChildFile (juce::String (H2P_TARGET_NAME) + ".log");
    static bool once = false;
    if (! once) { once = true; logFile.getParentDirectory().createDirectory(); if (logFile.getSize() > 512 * 1024) logFile.deleteFile(); }
    logFile.appendText (juce::Time::getCurrentTime().toISO8601 (true) + " " + line + "\n");
}

bool H2PProcessor::debugEnabled()
{
    static const bool on = [] { const char* e = getenv ("H2P_DEBUG"); return (e != nullptr && e[0] == '1')
        || juce::File::getSpecialLocation (juce::File::userHomeDirectory).getChildFile ("Library/Logs/html2plugin/DEBUG").exists(); }();
    return on;
}

void H2PProcessor::setEditorOpen (bool open)
{
    editorOpen.store (open);
    if (debugEnabled()) { log (open ? "editor opened" : "editor closed"); dumpRequested = true; }
}

void H2PProcessor::flushEngineErrors (const char* stage)
{
    if (! js) return;
    for (auto& e : js->takeNativeErrors()) { lastEngineError = e; log (juce::String (stage) + " exception: " + e); }
    juce::var errs = juce::JSON::parse (juce::String (js->takeErrors()));
    if (auto* a = errs.getArray()) for (auto& e : *a) { lastEngineError = e.toString(); log (juce::String (stage) + " engine error: " + e.toString()); }
}

juce::String H2PProcessor::assetString (const char* name)
{
    for (int i = 0; i < BinaryData::namedResourceListSize; ++i)
        if (juce::String (BinaryData::originalFilenames[i]) == name)
        {
            int size = 0; const char* d = BinaryData::getNamedResource (BinaryData::namedResourceList[i], size);
            return juce::String::fromUTF8 (d, size);
        }
    return {};
}

void H2PProcessor::loadManifest()
{
    manifest = juce::JSON::parse (assetString ("manifest.json"));
    pluginName = manifest.getProperty ("name", "HTML Plugin").toString();
    engineJs = assetString ("engine.js").toStdString();
    workletsJs = assetString ("worklets.js").toStdString();
    bootOpsJson = juce::JSON::toString (manifest.getProperty ("bootOps", juce::var (juce::Array<juce::var>())), true).toStdString();
    defs.clear();
    juce::Array<juce::var> names;
    if (auto* arr = manifest.getProperty ("params", juce::var()).getArray())
        for (auto& p : *arr)
        {
            H2PParamDef d;
            d.id = p["id"].toString(); d.name = p.getProperty ("name", d.id).toString(); d.type = p.getProperty ("type", "float").toString();
            d.min = (double) p.getProperty ("min", 0.0); d.max = (double) p.getProperty ("max", 1.0); d.def = (double) p.getProperty ("default", 0.0); d.step = (double) p.getProperty ("step", 0.0);
            d.bound = ! p["binding"].isVoid() && ! p["binding"].isUndefined();
            if (auto* ch = p["choices"].getArray()) for (auto& c : *ch) d.choices.push_back ({ c["label"].toString(), (double) c["value"] });
            if (d.type == "choice" && d.choices.size() < 2) { d.type = "float"; }
            if (d.type == "float" && ! (d.max > d.min)) { d.max = d.min + 1; }
            defs.push_back (d); names.add (d.id);
        }
    hostNamesJson = juce::JSON::toString (juce::var (names), true).toStdString();
}

juce::AudioProcessorValueTreeState::ParameterLayout H2PProcessor::buildLayout()
{
    loadManifest();
    juce::AudioProcessorValueTreeState::ParameterLayout layout;
    for (auto& d : defs)
    {
        if (d.type == "bool")
            layout.add (std::make_unique<juce::AudioParameterBool> (juce::ParameterID (d.id, 1), d.name, d.def >= 0.5));
        else if (d.type == "choice")
        {
            juce::StringArray labels; int defIdx = 0; double best = 1e300;
            for (size_t i = 0; i < d.choices.size(); ++i) { labels.add (d.choices[i].first); double e = std::abs (d.choices[i].second - d.def); if (e < best) { best = e; defIdx = (int) i; } }
            layout.add (std::make_unique<juce::AudioParameterChoice> (juce::ParameterID (d.id, 1), d.name, labels, defIdx));
        }
        else
        {
            juce::NormalisableRange<float> range ((float) d.min, (float) d.max, d.step > 0 ? (float) d.step : 0.0f);
            layout.add (std::make_unique<juce::AudioParameterFloat> (juce::ParameterID (d.id, 1), d.name, range, (float) juce::jlimit (d.min, d.max, d.def)));
        }
    }
    return layout;
}

H2PProcessor::H2PProcessor()
    : AudioProcessor (BusesProperties().withInput ("Input", juce::AudioChannelSet::stereo(), true).withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "H2P", buildLayout())
{
    const size_t n = defs.size();
    lastApplied.reset (new std::atomic<double>[n > 0 ? n : 1]); hostPush.reset (new std::atomic<double>[n > 0 ? n : 1]);
    dirty.reset (new std::atomic<bool>[n > 0 ? n : 1]); hostSetMs.reset (new std::atomic<juce::uint32>[n > 0 ? n : 1]);
    for (size_t i = 0; i < n; ++i) { params.push_back (apvts.getParameter (defs[i].id)); lastApplied[i] = 1e300; hostPush[i] = 0; dirty[i] = false; hostSetMs[i] = 0; }
    startTimerHz (30);
}

H2PProcessor::~H2PProcessor() { stopTimer(); }

double H2PProcessor::engineeringValue (int i) const
{
    auto* p = params[(size_t) i]; const auto& d = defs[(size_t) i];
    if (d.type == "bool") return p->getValue() >= 0.5f ? 1.0 : 0.0;
    if (d.type == "choice") { int idx = juce::jlimit (0, (int) d.choices.size() - 1, juce::roundToInt (p->getValue() * (float) (d.choices.size() - 1))); return d.choices[(size_t) idx].second; }
    return (double) p->convertFrom0to1 (p->getValue());
}

void H2PProcessor::setFromEngineering (int i, double v)
{
    auto* p = params[(size_t) i]; const auto& d = defs[(size_t) i]; float norm = 0;
    if (d.type == "bool") norm = v >= 0.5 ? 1.f : 0.f;
    else if (d.type == "choice") { int best = 0; double be = 1e300; for (size_t k = 0; k < d.choices.size(); ++k) { double e = std::abs (d.choices[k].second - v); if (e < be) { be = e; best = (int) k; } } norm = d.choices.size() > 1 ? (float) best / (float) (d.choices.size() - 1) : 0.f; }
    else norm = p->convertTo0to1 ((float) juce::jlimit (d.min, d.max, v));
    if (std::abs (p->getValue() - norm) > 1e-6f) p->setValueNotifyingHost (norm);
    lastApplied[(size_t) i] = engineeringValue (i);
}

void H2PProcessor::rebuildEngine (double sr, int block)
{
    js.reset (new JSHost());
    std::string err;
    if (! js->init (sr, block, engineJs, workletsJs, hostNamesJson, err))
    {
        lastEngineError = err; js.reset();
        log ("ENGINE INIT FAILED (plugin runs as pass-through): " + juce::String (err));
        log ("sizes: engine.js " + juce::String ((int) engineJs.size()) + " B, worklets.js " + juce::String ((int) workletsJs.size()) + " B, bootOps " + juce::String ((int) bootOpsJson.size()) + " B, hostNames " + juce::String (hostNamesJson));
        return;
    }
    js->applyOpsJSON (bootOpsJson);                 // the page's boot-time graph + default message, captured by the forge
    applyAllHostParams();
    flushEngineErrors ("boot");
    log ("engine ready: " + juce::String (sr, 0) + " Hz, block " + juce::String (block) + ", bootOps " + juce::String ((int) bootOpsJson.size()) + " B");
    log ("JavaScriptCore: " + juce::String (js->engineInfo) + "; 2e6-iteration float loop " + juce::String (js->jitProbeMs, 1) + " ms -> " + (js->jitLikelyOn() ? "JIT ON (compiled DSP)" : "JIT OFF (interpreter) — heavy worklets will not keep up"));
    preparedRate = sr; preparedBlock = block;
    generation++;
}

void H2PProcessor::applyAllHostParams()
{
    if (! js) return;
    for (size_t i = 0; i < defs.size(); ++i) { double v = engineeringValue ((int) i); js->hostParam (defs[i].id.toStdString(), v); lastApplied[i] = v; }
}

void H2PProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    if (! js || preparedRate != sampleRate || samplesPerBlock > preparedBlock) rebuildEngine (sampleRate, juce::jmax (samplesPerBlock, 128));
    zeroLatency = (samplesPerBlock % 128) == 0;
    setLatencySamples (zeroLatency ? 0 : 128);
    drainEvery = juce::jmax (1, juce::roundToInt (sampleRate / (30.0 * samplesPerBlock)));
    drainCountdown = 0; reapplyBlocks = 0;
}

void H2PProcessor::releaseResources() {}

bool H2PProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    auto in = layouts.getMainInputChannelSet(), out = layouts.getMainOutputChannelSet();
    if (out != juce::AudioChannelSet::mono() && out != juce::AudioChannelSet::stereo()) return false;
    if (in != juce::AudioChannelSet::mono() && in != juce::AudioChannelSet::stereo()) return false;
    return true;
}

void H2PProcessor::enqueueOps (const std::string& opsJson)
{
    if (debugEnabled()) log ("ops from page (" + juce::String ((int) opsJson.size()) + " B): " + juce::String (opsJson).substring (0, 20000));
    const juce::SpinLock::ScopedLockType sl (opsLock);
    opsPending.push_back (opsJson);
}
void H2PProcessor::markPageLoading() { pageLoading = true; }
void H2PProcessor::markPageSynced() { pageLoading = false; }

std::string H2PProcessor::hostValuesJSON() const
{
    juce::DynamicObject::Ptr o = new juce::DynamicObject();
    for (size_t i = 0; i < defs.size(); ++i) o->setProperty (defs[i].id, engineeringValue ((int) i));
    return juce::JSON::toString (juce::var (o.get()), true).toStdString();
}

bool H2PProcessor::takeDirtyHostParams (std::string& json)
{
    juce::DynamicObject::Ptr o = new juce::DynamicObject(); bool any = false;
    for (size_t i = 0; i < defs.size(); ++i) if (dirty[i].exchange (false)) { o->setProperty (defs[i].id, hostPush[i].load()); any = true; }
    if (any) json = juce::JSON::toString (juce::var (o.get()), true).toStdString();
    return any;
}

void H2PProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;
    const int n = buffer.getNumSamples(); const int inCh = getTotalNumInputChannels(), outCh = getTotalNumOutputChannels();
    for (int ch = inCh; ch < outCh; ++ch) buffer.clear (ch, 0, n);
    if (! js || ! js->isReady() || n == 0) return;   // engine failed to start: transparent pass-through, never silence

    // 1. ops recorded by the WebView shim
    bool sawReset = false;
    if (opsLock.tryEnter()) { opsWorking.swap (opsPending); opsLock.exit(); }
    for (auto& s : opsWorking) { if (s.find ("\"reset\"") != std::string::npos) sawReset = true; js->applyOpsJSON (s); }
    if (! opsWorking.empty()) { opsWorking.clear(); if (sawReset) reapplyBlocks = 12; }
    if (reapplyBlocks > 0) { --reapplyBlocks; applyAllHostParams(); }   // page just rebuilt its graph with its own defaults: re-impose host state

    // 2. host/automation parameter changes
    const juce::uint32 nowMs = juce::Time::getMillisecondCounter();
    for (size_t i = 0; i < defs.size(); ++i)
    {
        const double v = engineeringValue ((int) i);
        if (v != lastApplied[i].load()) { js->hostParam (defs[i].id.toStdString(), v); lastApplied[i] = v; hostPush[i] = v; dirty[i] = true; hostSetMs[i] = nowMs; }
    }

    // 3. audio
    if (zeroLatency && (n % 128) != 0) { zeroLatency = false; setLatencySamples (128); }
    const float* inL = buffer.getReadPointer (0); const float* inR = inCh > 1 ? buffer.getReadPointer (1) : inL;
    float* outL = buffer.getWritePointer (0); float* outR = outCh > 1 ? buffer.getWritePointer (1) : nullptr;
    js->render (inL, inR, outL, outR, n, zeroLatency);

    // 4. messages for the UI (~30 Hz)
    if (--drainCountdown <= 0)
    {
        drainCountdown = drainEvery;
        if (dumpRequested.exchange (false)) { std::string d = js->describe(); if (outLock.tryEnter()) { dumpPending.push_back (std::move (d)); outLock.exit(); } }
        std::string out = js->drainOutboxJSON (editorOpen.load());
        const bool hasMsgs = out.find ("\"msgs\":[]") == std::string::npos;
        const bool hasAnalysers = out.find ("\"analysers\":{") != std::string::npos && out.find ("\"analysers\":{}") == std::string::npos;
        if (++clockTick >= 30) clockTick = 0;                                   // once a second push the clock even when idle
        if (out.size() > 2 && (hasMsgs || hasAnalysers || clockTick == 0))
            if (outLock.tryEnter()) { if (outPending.size() < 64) outPending.push_back (std::move (out)); outLock.exit(); }
    }
}

void H2PProcessor::timerCallback()
{
    std::vector<std::string> work, dumps;
    { const juce::SpinLock::ScopedLockType sl (outLock); work.swap (outPending); dumps.swap (dumpPending); }
    for (auto& d : dumps) log ("graph: " + juce::String (d));
    for (auto& s : work)
    {
        juce::var v = juce::JSON::parse (juce::String (s));
        if (auto* msgs = v["msgs"].getArray())
            for (auto& m : *msgs)
            {
                const int id = (int) m["id"];
                if (id == -1) { lastEngineError = m["data"]["message"].toString(); log ("engine error: " + lastEngineError); }
                else if (id == -2 && ! pageLoading.load())
                {   // UI moved a control: reflect it in the host (unless the host itself set this param within the last 300 ms)
                    if (auto* vals = m["data"]["values"].getDynamicObject())
                        for (auto& kv : vals->getProperties())
                            for (size_t i = 0; i < defs.size(); ++i)
                                if (defs[i].id == kv.name.toString())
                                {
                                    const juce::uint32 age = juce::Time::getMillisecondCounter() - hostSetMs[i].load();
                                    if (age > 300) setFromEngineering ((int) i, (double) kv.value);
                                }
                }
            }
        if (onOutbox) onOutbox (s);
    }
    if (js && ! work.empty()) for (auto& e : js->takeNativeErrors()) { lastEngineError = e; log ("audio-thread exception: " + e); }
}

void H2PProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    auto st = apvts.copyState(); std::unique_ptr<juce::XmlElement> xml (st.createXml()); copyXmlToBinary (*xml, destData);
}

void H2PProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    std::unique_ptr<juce::XmlElement> xml (getXmlFromBinary (data, sizeInBytes));
    if (xml && xml->hasTagName (apvts.state.getType())) apvts.replaceState (juce::ValueTree::fromXml (*xml));
}

juce::AudioProcessorEditor* H2PProcessor::createEditor() { return new H2PEditor (*this); }

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new H2PProcessor(); }

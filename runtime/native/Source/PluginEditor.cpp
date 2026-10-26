#include "PluginEditor.h"

static juce::var slimManifest (const juce::var& m)
{   // what the page-side bridge needs (bootOps are only for the engine)
    juce::DynamicObject::Ptr o = new juce::DynamicObject();
    for (const char* k : { "name", "slug", "ui", "processors", "bindings", "params", "captureSampleRate" }) o->setProperty (k, m[k]);
    return juce::var (o.get());
}

juce::WebBrowserComponent::Options H2PEditor::makeOptions()
{
    using Opt = juce::WebBrowserComponent::Options;
    juce::DynamicObject::Ptr init = new juce::DynamicObject();
    init->setProperty ("sampleRate", proc.getSampleRate() > 0 ? proc.getSampleRate() : 48000.0);
    init->setProperty ("plugin", true);
    const juce::String html = H2PProcessor::assetString ("index.html");
    const juce::String shim = H2PProcessor::assetString ("shim.js");

    return Opt()
        .withBackend (Opt::Backend::defaultBackend)
        .withNativeIntegrationEnabled()
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withInitialisationData ("h2p_init", juce::var (init.get()))
        .withInitialisationData ("h2p_manifest", slimManifest (proc.getManifest()))
        .withUserScript (shim)
        .withEventListener ("h2p", [this] (juce::var payload)
        {
            if (auto* ops = payload["ops"].getArray())
            {
                if (ops->isEmpty()) return;
                for (auto& op : *ops) if (op["op"].toString() == "log") H2PProcessor::log ("page " + op["level"].toString() + ": " + op["text"].toString());
                proc.enqueueOps (juce::JSON::toString (payload["ops"], true).toStdString());
                receivedOps = true;
                // once the page has posted its own defaults, impose the host's state on its controls
                for (auto& op : *ops) if (op["op"].toString() == "post" && ! syncPending) { syncPending = true; syncAtMs = juce::Time::getMillisecondCounter() + 120; }
            }
        })
        .withResourceProvider ([html] (const juce::String& path) -> std::optional<juce::WebBrowserComponent::Resource>
        {
            if (path == "/" || path == "/index.html" || path.isEmpty())
            {
                juce::WebBrowserComponent::Resource r; auto utf8 = html.toRawUTF8(); size_t len = std::strlen (utf8);
                r.data.assign (reinterpret_cast<const std::byte*> (utf8), reinterpret_cast<const std::byte*> (utf8) + len); r.mimeType = "text/html";
                return r;
            }
            return std::nullopt;
        });
}

H2PEditor::H2PEditor (H2PProcessor& p) : AudioProcessorEditor (&p), proc (p)
{
    const auto ui = proc.getManifest()["ui"];
    const int w = juce::jlimit (400, 1800, (int) ui.getProperty ("width", 1000)), h = juce::jlimit (300, 1200, (int) ui.getProperty ("height", 700));
    web.reset (new juce::WebBrowserComponent (makeOptions()));
    addAndMakeVisible (*web);
    setResizable (true, true);
    setResizeLimits (400, 300, 2400, 1600);
    setSize (w, h);
    proc.onOutbox = [this] (const std::string& json) { if (web) web->evaluateJavascript ("window.__h2p && window.__h2p.receive(" + juce::String (json) + ");"); };
    proc.setEditorOpen (true);
    loadPage();
    startTimerHz (30);
}

H2PEditor::~H2PEditor()
{
    stopTimer();
    proc.onOutbox = nullptr;
    proc.setEditorOpen (false);
    web.reset();
}

void H2PEditor::loadPage()
{
    proc.markPageLoading();
    syncPending = false; receivedOps = false;
    generationSeen = proc.graphGeneration();
    web->goToURL (juce::WebBrowserComponent::getResourceProviderRoot());
}

void H2PEditor::timerCallback()
{
    if (proc.graphGeneration() != generationSeen) { loadPage(); return; }   // engine was rebuilt (sample-rate change): the page must rebuild its graph too
    if (syncPending && juce::Time::getMillisecondCounter() >= syncAtMs)
    {
        syncPending = false;
        web->evaluateJavascript ("window.__h2p && window.__h2p.applyHostParams && window.__h2p.applyHostParams(" + juce::String (proc.hostValuesJSON()) + ");");
        juce::Timer::callAfterDelay (400, [sp = juce::Component::SafePointer<H2PEditor> (this)] { if (sp != nullptr) sp->proc.markPageSynced(); });
    }
    std::string dirty;
    if (proc.takeDirtyHostParams (dirty))
        web->evaluateJavascript ("window.__h2p && window.__h2p.applyHostParams && window.__h2p.applyHostParams(" + juce::String (dirty) + ");");
}

void H2PEditor::paint (juce::Graphics& g) { g.fillAll (juce::Colours::black); }
void H2PEditor::resized() { if (web) web->setBounds (getLocalBounds()); }

#include "PluginEditor.h"

static juce::var slimManifest (const juce::var& m)
{   // what the page-side bridge needs (bootOps are only for the engine)
    juce::DynamicObject::Ptr o = new juce::DynamicObject();
    for (const char* k : { "name", "slug", "ui", "processors", "bindings", "params", "captureSampleRate", "residentPage" }) o->setProperty (k, m[k]);
    return juce::var (o.get());
}

// ------------------------------------------------------------------------------------------------ H2PPage
juce::WebBrowserComponent::Options H2PPage::makeOptions()
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

H2PPage::H2PPage (H2PProcessor& p) : proc (p)
{
    web.reset (new View (makeOptions()));
    web->setSize (1000, 700);
    proc.onOutbox = [this] (const std::string& json) { if (web) web->evaluateJavascript ("window.__h2p && window.__h2p.receive(" + juce::String (json) + ");"); };
    load();
    startTimerHz (30);
}

H2PPage::~H2PPage()
{
    stopTimer();
    proc.onOutbox = nullptr;
    web.reset();
}

void H2PPage::load()
{
    proc.markPageLoading();
    syncPending = false; receivedOps = false;
    generationSeen = proc.graphGeneration();
    web->goToURL (juce::WebBrowserComponent::getResourceProviderRoot());
}

void H2PPage::timerCallback()
{
    if (proc.graphGeneration() != generationSeen) { load(); return; }   // engine was rebuilt (sample-rate change): the page must rebuild its graph too
    if (syncPending && juce::Time::getMillisecondCounter() >= syncAtMs)
    {
        syncPending = false;
        web->evaluateJavascript ("window.__h2p && window.__h2p.applyHostParams && window.__h2p.applyHostParams(" + juce::String (proc.hostValuesJSON()) + ");");
        juce::Timer::callAfterDelay (400, [sp = juce::WeakReference<H2PProcessor> (&proc)] { if (sp != nullptr) sp->markPageSynced(); });
    }
    std::string dirty;
    if (proc.takeDirtyHostParams (dirty))
        web->evaluateJavascript ("window.__h2p && window.__h2p.applyHostParams && window.__h2p.applyHostParams(" + juce::String (dirty) + ");");
    // hidden pages get their DOM timers throttled to ~1 s by WebKit; the shim keeps its own timer list and fires overdue ones on this pulse
    if (! proc.isEditorOpen())
        web->evaluateJavascript ("window.__h2p && window.__h2p.tick && window.__h2p.tick();");
}

// ------------------------------------------------------------------------------------------------ H2PEditor
H2PEditor::H2PEditor (H2PProcessor& p) : AudioProcessorEditor (&p), proc (p)
{
    const auto ui = proc.getManifest()["ui"];
    const int w = juce::jlimit (400, 1800, (int) ui.getProperty ("width", 1000)), h = juce::jlimit (300, 1200, (int) ui.getProperty ("height", 700));
    page = proc.residentPage();
    if (page == nullptr) { ownPage.reset (new H2PPage (proc)); page = ownPage.get(); }
    addAndMakeVisible (page->component());
    setResizable (true, true);
    setResizeLimits (400, 300, 2400, 1600);
    setSize (w, h);
    proc.setEditorOpen (true);
    openedAt = juce::Time::getMillisecondCounter();
    startTimer (100);                                       // -> measure the page's natural size once it has rendered
}

H2PEditor::~H2PEditor()
{
    stopTimer();
    proc.setEditorOpen (false);
    if (page != nullptr && measured) page->setZoom (1.0);
    if (page != nullptr) removeChildComponent (&page->component());   // resident page survives; own page is destroyed below
    ownPage.reset();
}

void H2PEditor::paint (juce::Graphics& g) { g.fillAll (juce::Colours::black); }
void H2PEditor::resized()
{
    if (page == nullptr) return;
    if (measuring) return;                                   // probe bounds are in place
    page->component().setBounds (getLocalBounds());
    if (measured) applyZoom();
}

void H2PEditor::timerCallback()
{
    if (page == nullptr || measured || measuring) return;
    const juce::uint32 waited = juce::Time::getMillisecondCounter() - openedAt;
    if (! page->hasReceivedOps() && waited < 20000) return;  // page scripts not through yet (first paint follows them)
    if (page->hasReceivedOps() && waited < 400) return;      // one layout pass after the scripts
    stopTimer(); measuring = true;
    page->component().setBounds (0, 0, 1600, 1200);           // desktop-width probe viewport (clipped by the editor for a frame)
    page->measureNaturalSize ([this] (int w, int h) { measuring = false; adoptNaturalSize (w, h); });
}

void H2PEditor::adoptNaturalSize (int w, int h)
{
    measured = true;
    if (w < 300 || h < 200) { page->component().setBounds (getLocalBounds()); H2PProcessor::log ("editor: page size not measurable, keeping manifest size"); return; }
    natW = w; natH = h;
    double scale = proc.editorScale;
    if (scale <= 0)
    {   // auto-fit: natural size unless the screen (minus host chrome) is smaller
        scale = 1.0;
        if (auto* d = juce::Desktop::getInstance().getDisplays().getDisplayForRect (getScreenBounds()))
            scale = juce::jmin (1.0, (d->userArea.getWidth() - 40.0) / natW, (d->userArea.getHeight() - 110.0) / natH);
    }
    aspect.setFixedAspectRatio ((double) natW / natH);
    aspect.setSizeLimits (juce::roundToInt (natW * 0.4), juce::roundToInt (natH * 0.4), juce::roundToInt (natW * 1.5), juce::roundToInt (natH * 1.5));
    setConstrainer (&aspect);
    setResizable (true, true);
    setSize (juce::roundToInt (natW * scale), juce::roundToInt (natH * scale));
    page->component().setBounds (getLocalBounds()); applyZoom();
    H2PProcessor::log ("editor: page natural size " + juce::String (natW) + "x" + juce::String (natH) + ", shown at " + juce::String (getWidth()) + "x" + juce::String (getHeight()) + " (zoom " + juce::String (scale, 3) + ")");
}

void H2PEditor::applyZoom()
{
    if (natW <= 0) return;
    const double scale = (double) getWidth() / natW;
    proc.editorScale = scale;
    page->setZoom (scale);
}

void H2PPage::setZoom (double scale)
{
    web->evaluateJavascript ("document.documentElement.style.zoom = " + juce::String (scale, 5) + ";");
}

void H2PPage::measureNaturalSize (std::function<void (int, int)> done)
{
    // The union of all rendered boxes that do not simply stretch to the viewport (page backdrops), plus the page's own
    // margins (capped) -> what the author sees in a desktop browser window. Fixed-position elements are ignored.
    static const char* script = R"JS((() => {
  const de = document.documentElement, vw = innerWidth; de.style.zoom = '';
  const inter = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const clips = new Map();
  const clipOf = (el) => {           // clip imposed by ancestors: overflow != visible, or an <svg> box for its content
    if (clips.has(el)) return clips.get(el);
    const p = el.parentElement; let c = p ? clipOf(p) : null;
    if (p && p !== document.body && p !== de) {
      const cs = getComputedStyle(p);
      if (p instanceof SVGElement || /hidden|clip|scroll|auto/.test(cs.overflow + ' ' + cs.overflowX + ' ' + cs.overflowY)) { const r = p.getBoundingClientRect(); c = c ? inter(c, r) : { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }
    }
    clips.set(el, c); return c;
  };
  let L = Infinity, T = Infinity, R = 0, B = 0;
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el); if (cs.position === 'fixed' || cs.visibility === 'hidden' || cs.display === 'none') continue;
    let r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
    if (r.width >= vw - 2) continue;
    const c = clipOf(el); if (c) { r = inter(r, c); if (!(r.right > r.left && r.bottom > r.top)) continue; }
    L = Math.min(L, Math.max(0, r.left)); T = Math.min(T, Math.max(0, r.top)); R = Math.max(R, Math.min(vw, r.right)); B = Math.max(B, r.bottom);
  }
  if (!(R > L && B > T)) return { w: 0, h: 0 };
  const mx = Math.min(L, 48), my = Math.min(T, 48);
  return { w: Math.ceil(R - L + 2 * mx), h: Math.ceil(B - T + 2 * my), L, T, R, B };
})())JS";
    web->evaluateJavascript (script, [done] (juce::WebBrowserComponent::EvaluationResult res)
    {
        int w = 0, h = 0;
        if (auto* v = res.getResult()) { w = (int) (*v)["w"]; h = (int) (*v)["h"]; }
        else if (auto* err = res.getError()) H2PProcessor::log ("editor: natural size script failed: " + err->message);
        done (w, h);
    });
}

// Generic html2plugin editor: the original page, untouched, inside a JUCE 8 WebBrowserComponent with native integration.
// The shim (user script) turns the page's Web Audio calls into RPC ops that are forwarded to the processor.
//
// H2PPage = the page plus its host<->page sync logic. Normally the editor owns one (created when the window opens).
// Pages whose parameters change the *model* (netlists, filter matrices: "structural" messages the engine cannot
// synthesise from a single value) are built in "resident page" mode: the processor owns the page for its whole life,
// hidden, so automation with the editor closed still goes through the page's own JavaScript and reaches the DSP exactly.
#pragma once
#include <juce_gui_extra/juce_gui_extra.h>
#include "PluginProcessor.h"

class H2PPage : private juce::Timer
{
public:
    explicit H2PPage (H2PProcessor&);
    ~H2PPage() override;
    juce::Component& component() { return *web; }
    void load();
    bool hasReceivedOps() const { return receivedOps; }
    // Natural layout size of the page: the union of its (non viewport-stretching) boxes measured at a wide probe viewport,
    // plus its own margins. Result arrives asynchronously as (width, height) in CSS px; (0, 0) if it cannot be measured.
    void measureNaturalSize (std::function<void (int, int)> done);
    bool nativeZoom = false;                                                   // last zoom went through WebKit page zoom
    // CSS zoom applied to the document so a page laid out at its natural size fills an editor of a different size exactly
    void setZoom (double scale);

private:
    // JUCE reloads the last URL every time the component (re)appears in a window, which would reboot the page (and the
    // audio graph) on each editor open. The NSView attachment is handled elsewhere (NSViewComponent), so skipping these is safe.
    struct View : public juce::WebBrowserComponent
    {
        using juce::WebBrowserComponent::WebBrowserComponent;
        void parentHierarchyChanged() override {}
        void visibilityChanged() override {}
    };
    H2PProcessor& proc;
    std::unique_ptr<View> web;
    int generationSeen = -1;
    bool syncPending = false; juce::uint32 syncAtMs = 0;
    bool receivedOps = false;
    juce::WebBrowserComponent::Options makeOptions();
    void timerCallback() override;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (H2PPage)
};

class H2PEditor : public juce::AudioProcessorEditor, private juce::Timer
{
public:
    explicit H2PEditor (H2PProcessor&);
    ~H2PEditor() override;
    void paint (juce::Graphics&) override;
    void resized() override;

private:
    H2PProcessor& proc;
    std::unique_ptr<H2PPage> ownPage;   // non-resident mode
    H2PPage* page = nullptr;            // the page shown (own or the processor's resident one)
    // The page is shown at its own natural layout (what the browser shows on a desktop window), scaled to fit the screen
    // and to the user's resizing with a fixed aspect ratio; CSS zoom keeps the layout identical at any window size.
    int natW = 0, natH = 0; bool measuring = false, measured = false; juce::uint32 openedAt = 0;
    juce::ComponentBoundsConstrainer aspect;
    void timerCallback() override;
    void adoptNaturalSize (int w, int h);
    void applyZoom();
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (H2PEditor)
};

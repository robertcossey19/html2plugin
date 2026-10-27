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

class H2PEditor : public juce::AudioProcessorEditor
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
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (H2PEditor)
};

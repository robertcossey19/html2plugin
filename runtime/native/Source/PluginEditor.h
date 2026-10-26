// Generic html2plugin editor: the original page, untouched, inside a JUCE 8 WebBrowserComponent with native integration.
// The shim (user script) turns the page's Web Audio calls into RPC ops that this editor forwards to the processor.
#pragma once
#include <juce_gui_extra/juce_gui_extra.h>
#include "PluginProcessor.h"

class H2PEditor : public juce::AudioProcessorEditor, private juce::Timer
{
public:
    explicit H2PEditor (H2PProcessor&);
    ~H2PEditor() override;
    void paint (juce::Graphics&) override;
    void resized() override;

private:
    H2PProcessor& proc;
    std::unique_ptr<juce::WebBrowserComponent> web;
    int generationSeen = -1;
    bool syncPending = false; juce::uint32 syncAtMs = 0;
    bool receivedOps = false;

    juce::WebBrowserComponent::Options makeOptions();
    void loadPage();
    void timerCallback() override;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (H2PEditor)
};

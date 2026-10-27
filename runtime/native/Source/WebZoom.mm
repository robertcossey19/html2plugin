// Fit-to-screen zoom for the page, done by WebKit's own page zoom (what Cmd-minus does in Safari) rather than CSS `zoom`.
// CSS zoom scales the drawing but leaves the media-query viewport at the device width, so a page measured two-column at its
// natural 1120 px collapses to its phone/tablet layout when shown at 1016 px (Tailwind's lg: breakpoint is 1024). WebKit page zoom
// widens the CSS viewport instead (1016 / 0.907 = 1120 CSS px), so the layout the author designed survives the shrink.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

static WKWebView* findWebView (NSView* v)
{
    if ([v isKindOfClass: [WKWebView class]]) return (WKWebView*) v;
    for (NSView* c in [v subviews]) if (WKWebView* w = findWebView (c)) return w;
    return nil;
}

// nsViewRoot: the plugin editor's own native view (JUCE peer handle). Returns 1 if the zoom was applied natively, 0 if the
// web view was not found under that view (caller falls back to CSS zoom).
extern "C" int h2p_setPageZoom (void* nsViewRoot, double zoom)
{
    @autoreleasepool
    {
        NSView* root = (__bridge NSView*) nsViewRoot;
        WKWebView* wk = findWebView (root);
        if (wk == nil) return 0;
        if (@available (macOS 11.0, *)) { wk.pageZoom = zoom; return 1; }
        return 0;
    }
}

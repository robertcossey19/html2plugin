// Snapshot of the plugin editor's web view, rendered by WebKit itself (no screen-recording permission needed, unlike
// screencapture, which returns black on CI runners). Finds the WKWebView under the window's content view.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <string>

static WKWebView* findWebView (NSView* v)
{
    if ([v isKindOfClass: [WKWebView class]]) return (WKWebView*) v;
    for (NSView* c in [v subviews]) if (WKWebView* w = findWebView (c)) return w;
    return nil;
}

// Returns: 1 written, 0 no web view found, -1 snapshot failed. Pumps the run loop while waiting (max ~10 s).
extern "C" int h2p_snapshotWebView (void* nsViewOfWindowContent, const char* pngPath)
{
    @autoreleasepool
    {
        NSView* root = (__bridge NSView*) nsViewOfWindowContent;
        NSWindow* win = [root window];
        NSView* top = win != nil ? [win contentView] : root;
        WKWebView* wk = findWebView (top);
        if (wk == nil) return 0;
        __block int state = 0; __block NSImage* image = nil;
        [wk takeSnapshotWithConfiguration: nil completionHandler: ^(NSImage* img, NSError* err) { image = img; state = (img != nil && err == nil) ? 1 : -1; }];
        NSDate* deadline = [NSDate dateWithTimeIntervalSinceNow: 10.0];
        while (state == 0 && [deadline timeIntervalSinceNow] > 0)
            [[NSRunLoop currentRunLoop] runMode: NSDefaultRunLoopMode beforeDate: [NSDate dateWithTimeIntervalSinceNow: 0.05]];
        if (state != 1) return -1;
        CGImageRef cg = [image CGImageForProposedRect: nil context: nil hints: nil];
        NSBitmapImageRep* rep = [[NSBitmapImageRep alloc] initWithCGImage: cg];
        NSData* png = [rep representationUsingType: NSBitmapImageFileTypePNG properties: @{}];
        return [png writeToFile: [NSString stringWithUTF8String: pngPath] atomically: YES] ? 1 : -1;
    }
}

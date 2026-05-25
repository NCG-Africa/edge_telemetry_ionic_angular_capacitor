#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Capacitor 6+ plugin macros — exposes the Swift plugin to the bridge.
// The Swift class name must match `objc(EdgeRumCrashPlugin)` exactly.
CAP_PLUGIN(EdgeRumCrashPlugin, "EdgeRumCrash",
  CAP_PLUGIN_METHOD(install, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(fetchPending, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(markHandled, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(setLastScreen, CAPPluginReturnPromise);
)

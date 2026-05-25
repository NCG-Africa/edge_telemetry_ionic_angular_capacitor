# @nathanclaire/rum-capacitor

## 3.3.4

### Patch Changes

- iOS: remove legacy `.m` registration file; migrate to Swift-only
  `CAPBridgedPlugin` pattern. Fixes the SwiftPM "mixed language source files;
  feature not supported" error that broke 3.3.2 and 3.3.3 on SPM-only
  Capacitor 8 consumers at package-resolution time. The `CAP_PLUGIN` macro
  registration is now in Swift via `identifier` / `jsName` / `pluginMethods`,
  matching the official `@capacitor/*` plugin pattern. Bridged methods
  (`install`, `fetchPending`, `markHandled`, `setLastScreen`) and the
  `EdgeRumCrash` JS name are unchanged.

## 3.3.3

### Patch Changes

- Add `EdgeRumCrashPlugin.load()` override as a verification hook for
  SPM/CocoaPods consumers. Fires at Capacitor framework boot, before JS;
  emits `[edge-rum] EdgeRumCrashPlugin loaded` to the device console in
  debug builds. Set a breakpoint on the method to confirm the plugin
  linked correctly, independent of whether the JS bridge has called
  `plugin.install()` yet.

## 3.3.2

### Patch Changes

- Fix SPM resolution for Capacitor 8 consumers. `Package.swift` now depends
  on `capacitor-swift-pm` `from: "8.0.0"` (was `from: "7.0.0"`, which capped
  at `<8.0.0` and conflicted with Cap 8 consumers' 8.x resolution) and uses
  `.iOS(.v15)` to match the `@capacitor/app` v8 template. Capacitor 7 SPM is
  no longer supported by this package; Capacitor 7 CocoaPods consumers
  continue to work via the podspec.

## 3.3.1

### Patch Changes

- Add SPM support for Capacitor 8 consumers (`Package.swift` at the package
  root; library product `EdgeRumCapacitor`, target rooted at `ios/Plugin`,
  depends on `capacitor-swift-pm` 7+). SPM-only iOS projects were silently
  dropping the plugin during `npx cap sync ios`; this restores the native
  bridge for that install path. CocoaPods path unchanged. iOS deployment
  target raised from 13.0 → 14.0 to align both install paths with
  `capacitor-swift-pm` 7+ requirements.

## 1.0.5

### Patch Changes

- fix: move @nathanclaire/rum to peerDependencies in rum-angular; add deferFlush config and Pipeline.markReady() to prevent first-batch device_id race condition
- Updated dependencies
  - @nathanclaire/rum@1.0.5

## 1.0.4

### Patch Changes

- fix: include device_id at batch payload root level for collector server compatibility
- Updated dependencies
  - @nathanclaire/rum@1.0.4

## 1.0.3

### Patch Changes

- fix: flatten batch payload to match collector server schema — `events` is now a top-level field instead of nested under `data.events`
- Updated dependencies
  - @nathanclaire/rum@1.0.3

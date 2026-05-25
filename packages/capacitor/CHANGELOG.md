# @nathanclaire/rum-capacitor

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

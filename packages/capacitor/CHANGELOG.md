# @nathanclaire/rum-capacitor

## 4.0.0

### Major Changes

- 9bb6b79: BREAKING: Align outbound payload with the EdgeTelemetryProcessor contract.

  Envelope:

  - `type` changes from `"batch"` to `"telemetry_batch"`.
  - Top-level `device_id` field is removed (each event still carries `device.id` in `attributes`).
  - New optional top-level `location` field, sourced from `EdgeRumConfig.location` (e.g. `"Nairobi/Kenya"`).
  - `tenant_id` is added by the backend collector from the API key — the SDK no longer sends it.

  Event renames:

  - `network_request` → `http.request`. Attribute keys move from `network.*` to `http.*`:
    - `http.url`, `http.method`, `http.status_code`, `http.duration_ms`
    - new: `http.success` (boolean), `http.timestamp` (ISO 8601)
    - removed: `network.request_body_size`, `network.response_body_size`, `network.parent_screen`
    - `network.type` (wifi / cellular / etc.) stays on every event as part of the context block.
  - `screen_view` is no longer emitted. The `navigation` event is the entry marker.
  - `screen_timing` is replaced by `screen.duration`, emitted only on screen exit with full dwell time and `screen.exit_method` (currently always `"navigate"`).
  - `navigation.duration_ms` removed from the `navigation` event (backend ignored it).

  Config:

  - `EdgeRumConfig.location?: string` added (optional).

### Patch Changes

- Updated dependencies [9bb6b79]
  - @nathanclaire/rum@4.0.0

## 3.3.7

### Patch Changes

- **Fix `"EdgeRumCrash.then() is not implemented on android"` error.**
  `defaultLoadPlugin` returned the Capacitor plugin proxy directly from an
  `async` function. The proxy intercepts every property access — including
  `.then` — so JavaScript's thenable assimilation called `proxy.then()` when
  resolving the returned Promise, Capacitor routed that to the native side,
  and Android responded with the "not implemented" error (which then got
  captured by the SDK's own error pipeline and sent as telemetry, creating a
  feedback loop). Fixed by wrapping the proxy in a plain object exposing only
  the four methods we actually call (`install`, `fetchPending`,
  `markHandled`, `setLastScreen`).
- **iOS: `network.type` no longer stuck as `unknown` for the session.**
  `startNetworkCapture`'s `networkStatusChange` listener now writes the
  latest `network.type` / `network.connected` (plus `effectiveType` /
  `downlinkMbps` when available) back to `ContextManager` so subsequent
  events carry the current value. Previously the listener only emitted a
  `network_change` event, so iOS's NWPathMonitor cold-start race
  (first `getStatus()` resolves as `'unknown'`) was never corrected and
  every event in the session carried the stale value.
- **Honour the documented navigator fallback in `getInitialNetworkContext`.**
  When the native `@capacitor/network` `getStatus()` throws (e.g. plugin
  not installed in the consuming app), the code now actually falls through
  to `navigator.onLine` / `navigator.connection` instead of silently leaving
  the defaults — matching the existing comment.

## 3.3.6

### Patch Changes

- **iOS cold-start perf: defer native crash install off the bootstrap
  critical path.** `plugin.install()` and `plugin.fetchPending()` now run
  on the next idle tick (`requestIdleCallback` / `setTimeout(0)` fallback)
  instead of blocking Angular's `APP_INITIALIZER`. Measured 50–150 ms
  cold-start improvement on modern devices, up to ~200 ms on older
  devices / first install. The screen-relay listener is still wired
  synchronously so crashes during the deferred-install gap retain the
  correct screen context. Opt-out via `awaitNativeInstall: true` in
  `EdgeRumConfig` or `startCapacitorCapture` options. No data loss —
  pending crashes from session N-1 simply surface a few hundred ms later
  (batch 2 of session N instead of batch 1).
- **iOS: drop eager local symbolication
  (`PLCrashReporterConfig(symbolicationStrategy: .none)`).** Raw addresses
  ship in the crash record with `crash.symbolication: "required"` and
  the backend symbolicates from uploaded dSYMs — the standard pattern
  for production crash SDKs.
- New `awaitNativeInstall?: boolean` option on `CapacitorCaptureOptions`
  for consumers who absolutely need the native crash handlers armed
  before any other code runs (rare).

## 3.3.5

### Patch Changes

- iOS: rename SPM product to `NathanclaireRumCapacitor` to match Capacitor
  CLI's auto-generated consumer manifest. Fixes "product 'NathanclaireRumCapacitor'
  not found in package 'NathanclaireRumCapacitor'" SwiftPM error in 3.3.4 on
  SPM-only Capacitor 8 consumers. The CLI derives the consumer-side
  `.package(name: ...)` / `.product(name: ...)` entries from
  `fixName(npmPackageName)`, not from `capacitor.ios.name`. Swift class
  name, jsName, podspec name, and bridged methods unchanged.

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

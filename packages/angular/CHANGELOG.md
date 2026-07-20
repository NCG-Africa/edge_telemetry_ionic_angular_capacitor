# @nathanclaire/rum-angular

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

## 3.3.1

### Patch Changes

- **Fix: `IonicLifecycleCapture` now emits a closing `screen.duration`
  on `session.finalized`.** Previously the capture kept a private
  `currentScreen` field and only emitted on `ionViewDidLeave`, so apps
  that backgrounded / closed without first navigating away from a screen
  silently dropped the final `screen.duration`. The capture now
  registers the active screen via the new core helper
  `__beginScreen(name)` on `ionViewDidEnter` and calls
  `__flushActiveScreen(method)` on `ionViewDidLeave`. The existing
  lifecycle finalize wiring in `@nathanclaire/rum-capacitor` then closes
  the in-flight screen automatically on backgrounding and on
  `pagehide` / `beforeunload`. Requires `@nathanclaire/rum@^3.3.2`. See
  issue #37.
- **Behavior change:** an `ionViewDidLeave` without a preceding
  `ionViewDidEnter` no longer synthesises a duration-0 `screen.duration`
  event. The old emission was noise; the processor side handles
  orphaned navigations.
- Updated dependencies
  - @nathanclaire/rum@3.3.2

## 1.0.6

### Patch Changes

- fix: force-instantiate RouterCapture and IonicLifecycleCapture via APP_INITIALIZER deps to emit screen_view and screen_timing events

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

## 1.0.2

### Patch Changes

- e29f31f: fix(angular): compile with ng-packagr for AOT compatibility

  Migrated the Angular package build from tsup (esbuild) to ng-packagr with
  `compilationMode: 'partial'`. This generates the Ivy definition fields
  (ɵfac, ɵprov, ɵmod) that Angular AOT consumers require, resolving the
  "JIT compiler unavailable" error.

  - Replaced tsup with ng-packagr for Angular Package Format (APF) output
  - Fixed Router import in RouterCapture from type-only to value import for DI
  - Added InjectionToken wrappers (ERROR_ROUTE_PROVIDER, LIFECYCLE_EVENT_SOURCE)
    for non-injectable constructor params with @Optional() @Inject()
  - Exported new tokens from public API
  - Updated build artifact, pack audit, and publish config tests for APF output
  - Added unit tests for DI compatibility and integration tests for Ivy metadata

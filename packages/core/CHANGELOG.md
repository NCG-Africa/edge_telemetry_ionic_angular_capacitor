# @nathanclaire/rum

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

## 3.3.2

### Patch Changes

- **New internal export `__beginScreen(name)`** to register the in-flight
  screen in core's `state.activeScreen`. Used by
  `@nathanclaire/rum-angular@3.3.1`'s `IonicLifecycleCapture` so that the
  closing `screen.duration` fires automatically on `session.finalized`
  (background / app close). No public API change. See tracking issue #37.

## 3.3.1

### Patch Changes

- **Bundle: kill `Critical dependency: the request of a dependency is an
expression` webpack warning.** `OfflineQueue` now imports
  `@capacitor/preferences` via a string literal with
  `/* webpackIgnore: true */` and `/* @vite-ignore */` magic comments
  instead of an indirect variable. Pure-web consumers can finally
  tree-shake the Capacitor Preferences fallback out of their webpack /
  Vite / Rollup bundles, and the warning is gone from build logs.
- New `EdgeRumConfig.awaitNativeInstall?: boolean` field (default
  `false`). Controls whether the Capacitor native crash bridge installs
  synchronously during bootstrap. The capacitor package consumes this
  flag to defer `plugin.install()` + `plugin.fetchPending()` off the
  cold-start critical path. See `@nathanclaire/rum-capacitor@3.3.6`
  for the timing impact.

## 1.0.5

### Patch Changes

- fix: move @nathanclaire/rum to peerDependencies in rum-angular; add deferFlush config and Pipeline.markReady() to prevent first-batch device_id race condition

## 1.0.4

### Patch Changes

- fix: include device_id at batch payload root level for collector server compatibility

## 1.0.3

### Patch Changes

- fix: flatten batch payload to match collector server schema — `events` is now a top-level field instead of nested under `data.events`

# @nathanclaire/rum-angular

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

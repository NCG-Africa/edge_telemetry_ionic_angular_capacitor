# @nathanclaire/rum-angular

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

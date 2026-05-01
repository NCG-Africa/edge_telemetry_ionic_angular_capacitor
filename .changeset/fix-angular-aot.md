---
"@nathanclaire/rum-angular": patch
---

fix(angular): compile with ng-packagr for AOT compatibility

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

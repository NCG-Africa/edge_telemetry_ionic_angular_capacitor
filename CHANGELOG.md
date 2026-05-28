# Changelog

All notable changes to the edge-rum SDK are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project follows
[Semantic Versioning](https://semver.org/).

## [@nathanclaire/rum-angular 3.3.1] — 2026-05-28
## [@nathanclaire/rum 3.3.2] — 2026-05-28

### Fixed

- **`IonicLifecycleCapture` now emits a closing `screen.duration` on
  `session.finalized` (background / app close / pagehide).** Previously
  the Angular capture kept a private `currentScreen` field that was
  invisible to the core's finalize flush, so apps using the default
  `EdgeRumModule` wiring silently dropped the final `screen.duration`
  whenever the user didn't navigate away before backgrounding. The
  capture now registers the active screen with core via the new
  internal helper `__beginScreen(name)` on `ionViewDidEnter` and calls
  `__flushActiveScreen(method)` on `ionViewDidLeave`. The existing
  `packages/capacitor/src/LifecycleCapture.ts` finalize wiring then
  closes the in-flight screen automatically with
  `screen.exit_method = "backgrounded"` or `"app_closed"`. Tracking
  issue #37.

  Note: this does not fix the case of an OS process kill or a hard
  native crash — by definition the JS heap is gone before any handler
  runs. The processor-side synthesis fallback is the correct backstop
  for those cases.

- **Behavior change in `IonicLifecycleCapture`:** an `ionViewDidLeave`
  fired without a preceding `ionViewDidEnter` no longer synthesises a
  duration-0 `screen.duration` event with a fallback `"unknown"` name.
  The old emission was noise.

### Added

- **`@nathanclaire/rum`: new internal export `__beginScreen(name)`.**
  Registers an active screen in core's `state.activeScreen` so the
  existing `__flushActiveScreen` finalize path can close it. Internal
  API (underscore-prefixed) — consumed by
  `@nathanclaire/rum-angular@3.3.1`. No public API change.

## [@nathanclaire/rum-capacitor 3.3.6] — 2026-05-25
## [@nathanclaire/rum 3.3.1] — 2026-05-25

### Performance

- **iOS cold-start: defer native crash install off the bootstrap critical
  path.** `plugin.install()` + `plugin.fetchPending()` now run on the next
  idle tick (`requestIdleCallback` / `setTimeout(0)` fallback) instead of
  blocking Angular's `APP_INITIALIZER`. Measured **50–150 ms** cold-start
  improvement on modern devices, up to **~200 ms** on older devices /
  first install. Consumers who want the previous synchronous behaviour
  can opt in via `awaitNativeInstall: true` in `EdgeRumConfig`. Crashes
  from session N-1 surface in batch 2 of session N (a few hundred ms
  later) instead of batch 1 — no data loss, just deferred replay.
- **iOS: drop eager local symbolication.** `PLCrashReporterConfig` now uses
  `symbolicationStrategy: .none` instead of `.all`. Raw addresses are
  shipped in the crash record (`crash.symbolication: "required"`) and the
  backend symbolicates from uploaded dSYMs — the standard pattern for
  production crash SDKs (Sentry / Crashlytics / Datadog). Avoids the
  crash-time cost of in-process symbol-table walks and keeps the dump
  small.
- **Bundle: kill `Critical dependency: the request of a dependency is an
  expression` webpack warning.** The `@capacitor/preferences` dynamic
  import in `OfflineQueue` now uses a string literal with
  `/* webpackIgnore: true */ /* @vite-ignore */` magic comments so
  bundlers can statically code-split it. Pure-web consumer builds can
  finally tree-shake the Capacitor Preferences fallback out of their
  bundle.

### Added

- `EdgeRumConfig.awaitNativeInstall?: boolean` — opt-out for the deferred
  native install. Default `false` (deferred). Set to `true` if you
  absolutely need the native crash handlers armed before any other code
  runs (rare — the gap is typically <50 ms and crashes during it are
  exceedingly uncommon).
- `CapacitorCaptureOptions.awaitNativeInstall?: boolean` — same option
  exposed at the `startCapacitorCapture()` level.

## [@nathanclaire/rum-capacitor 3.3.5] — 2026-05-25

### Fixed

- **iOS: rename SPM product to `NathanclaireRumCapacitor` to match
  Capacitor CLI's auto-generated consumer manifest.** Fixes the
  `"product 'NathanclaireRumCapacitor' required by package 'capapp-spm'
  target 'CapApp-SPM' not found in package 'NathanclaireRumCapacitor'"`
  SwiftPM error on Capacitor 8 SPM consumers.

  The Capacitor CLI's `cap sync ios` writes the consumer's
  `CapApp-SPM/Package.swift` using `plugin.ios?.name`, which is set in
  `cli/src/ios/common.ts` to `plugin.name` — the result of `fixName(npmPackageName)`
  from `cli/src/plugin.ts`. For `@nathanclaire/rum-capacitor` this produces
  `NathanclaireRumCapacitor`. The CLI does **not** read `capacitor.ios.name`
  for SPM at all (that field is only honoured by the legacy CocoaPods path
  via the podspec name). So the plugin's `Package.swift` must declare a
  package name + library product name that matches the auto-derived value
  the CLI emits, or `swift package resolve` fails before any source compiles.

  Behavioural surface unchanged: the `@objc(EdgeRumCrashPlugin)` Swift class
  name, the `jsName = "EdgeRumCrash"` JS bridge identifier, the
  `EdgeRumCapacitor` CocoaPods podspec name, and all four bridged methods
  are untouched. Only the SPM-side `name` / `products[0].name` /
  `targets[0].name` in `Package.swift` rename to `NathanclaireRumCapacitor` /
  `NathanclaireRumCapacitorPlugin`.

## [@nathanclaire/rum-capacitor 3.3.4] — 2026-05-25

### Fixed

- **iOS: remove legacy `.m` registration file; migrate to Swift-only
  `CAPBridgedPlugin` pattern.** Fixes the SwiftPM "mixed language source
  files; feature not supported" error that broke 3.3.2 and 3.3.3 on
  SPM-only Capacitor 8 consumers at package-resolution time. The
  `EdgeRumCrashPlugin.m` file's `CAP_PLUGIN` macro registration is now
  declared in `EdgeRumCrashPlugin.swift` via the `identifier`, `jsName`,
  and `pluginMethods` properties of `CAPBridgedPlugin` — matching the
  pattern every official `@capacitor/*` plugin uses (see `@capacitor/app`).
  Behavioural surface is unchanged — same four bridged methods (`install`,
  `fetchPending`, `markHandled`, `setLastScreen`) with the same `EdgeRumCrash`
  JS name. The `Package.swift` comment in 3.3.3 that claimed mixed-language
  SPM targets work via the `@objc` runtime bridge was wrong; SwiftPM rejects
  such targets at resolve time, before any ObjC class loader runs.

## [@nathanclaire/rum-capacitor 3.3.3] — 2026-05-25

### Added

- `EdgeRumCrashPlugin.load()` override on the iOS plugin. Fires once at
  Capacitor framework boot, before any JS runs — gives consumers a stable
  breakpoint target in Xcode (and a `[edge-rum]` debug-build console log)
  to verify SPM/CocoaPods linkage independently of whether the JS bridge
  has called `plugin.install()` yet. No behavioural change to the install
  path.

## [@nathanclaire/rum-capacitor 3.3.2] — 2026-05-25

### Fixed

- **`Package.swift` was unresolvable on Capacitor 8 SPM consumers.** The
  previous declaration depended on `capacitor-swift-pm` `from: "7.0.0"`,
  which SwiftPM resolves as `7.0.0 ..< 8.0.0`. `capacitor-swift-pm`'s
  major version is aligned with Capacitor's major version (7.x → Capacitor
  7, 8.x → Capacitor 8), so a Capacitor 8 consumer's `CapApp-SPM/Package.swift`
  pulls in 8.x and conflicted with our 7.x pin — manifesting either as a
  resolution error during `cap sync ios` or as the plugin being silently
  dropped (which is the warning users were seeing in the wild). Switched
  the pin to `from: "8.0.0"` and the platform target from `.iOS(.v14)` to
  `.iOS(.v15)` to match the official `@capacitor/app` v8 template. Capacitor
  7 CocoaPods consumers continue to work unchanged via the podspec;
  Capacitor 7 SPM is no longer supported by this package (was effectively
  broken anyway).

## [@nathanclaire/rum-capacitor 3.3.1] — 2026-05-25

### Fixed

- **Add SPM support for Capacitor 8 consumers.** SPM-only iOS projects (no
  `Podfile`) were silently dropping `@nathanclaire/rum-capacitor` during
  `npx cap sync ios` with `[warn] @nathanclaire/rum-capacitor does not have
  a Package.swift`. Result: the native iOS plugin (`EdgeRumCrashPlugin`,
  `HangDetector`, `CrashReporter`) never loaded at runtime. Adds a
  `Package.swift` at the package root following the official capacitor-team
  plugin template — single target rooted at `ios/Plugin`, depends on
  `capacitor-swift-pm` `from: "7.0.0"` (covers Capacitor 7 + 8). CocoaPods
  consumers continue to resolve via the existing
  `ios/EdgeRumCapacitor.podspec`. The podspec's iOS deployment target is
  bumped from 13.0 → 14.0 to match `capacitor-swift-pm` 7+ requirements so
  the SPM and CocoaPods install paths share a single minimum.

## [2.0.0] — 2026-05-15

### Breaking

- **`UserContext` shape changed** to `{ name?, email?, phone? }`. Consumers
  calling `EdgeRum.identify({ id: '...' })` or passing custom keys will get a
  TypeScript error. Pass `name` / `email` / `phone` only; pass `null` to
  clear a field; pass `undefined` (or omit) to leave it untouched.
- **`user.id` is now SDK-owned.** It is auto-generated at `EdgeRum.init()`
  (`user_<ts>_<8hex>`) and persisted to `localStorage` so it survives reloads.
  Consumers cannot set or override it via `identify()`.
- **PII firewall removed.** Previously the SDK silently stripped `email`,
  `phone`, `name`, `username`, `password` from `user.*`. With the new
  identify shape, `user.name` / `user.email` / `user.phone` are sent as
  provided. Consumers are responsible for collecting consent and configuring
  backend retention. See `docs/privacy.md`.

### Fixed

- **`device.*` and `app.*` are now back-filled at flush time** for events
  recorded before Capacitor's device context loads (which previously meant
  `navigation`, `screen_view`, and `network_request` events emitted during
  the first ~100–300ms after `init()` had no `device.*`). Stable context
  (`app.*`, `device.*`, `sdk.*`) is back-filled; volatile context
  (`session.*`, `user.*`, `network.*`) stays captured-at-record-time.

### Changed

- Switched the release workflow from changesets-driven to tag-driven. Push a
  `v*.*.*` tag on `main` and `release.yml` runs `pnpm release` to publish all
  packages whose `package.json` version is ahead of npm. No Version Packages
  PR, no bot — just bump versions in your release commit, tag, push.

## [1.2.0] — 2026-05-14

### Changed

- **Wire format aligned with `EdgeTelemetryProcessor`.** Three attribute keys
  renamed to snake_case: `app.package` → `app.package_name`,
  `session.startTime` → `session.start_time`,
  `device.osVersion` → `device.platform_version`. The old keys are no longer
  emitted. Required for the backend to stop silently dropping events.
- `EdgeRum.time().end()` now produces a top-level metric item
  (`{ type: "metric", metricName, value, timestamp, attributes }`) instead of
  a `custom_metric` event with `metric.name`/`metric.value` nested in
  attributes. The processor's metric handler keys on `type === "metric"`. The
  user-facing `EdgeRum.time(name).end()` API is unchanged.
- Angular route changes now emit two items per navigation: a `navigation`
  event carrying all `navigation.*` attributes (the processor's navigation
  handler keys on `eventName === "navigation"`), and a stripped `screen_view`
  event carrying only `navigation.to_screen`.

### Added

- Batch envelope now includes `batch_size` (= `events.length`) at the root.
- Every event carries `app.build_number`. Sourced from Capacitor
  `App.getInfo().build` on native platforms; empty string on web.
- `MetricPayload` and `BatchItem` types exported from `@nathanclaire/rum` for
  consumers wiring custom transports.

### Fixed

- Event-batch POSTs from native Capacitor platforms now bypass the webview
  fetch + CORS preflight by routing through `CapacitorHttp.request` instead
  of `globalThis.fetch`. The SDK no longer depends on the consumer's
  `plugins.CapacitorHttp.enabled` setting in `capacitor.config.ts` to work
  on iOS/Android. Web and PWA continue to use `fetch`.
  (Previously prepared as 1.1.1; included here as 1.1.1 was never published.)

## [1.0.0] — 2026-04-24

### Added

- Transport layer: `PayloadBuilder`, `RetryTransport` with `X-API-Key` auth and
  exponential backoff (immediate / 2s / 8s / 30s → offline queue), `SessionManager`
  with 30-minute inactivity expiry, `ContextManager` merging app / device / network /
  session / user / sdk attributes into every event.
- Internal `pipeline` and `collector` connecting capture hooks to the
  transport. `EdgeRum.init()` now wires and starts all capture automatically.
- HTTP request capture via `fetch` monkey-patch producing `network_request` events.
- `startCapacitorCapture()` convenience function that wires device context,
  network capture, and lifecycle capture (including session timeout / renewal)
  to the core pipeline in a single call.
- Default URL sanitiser runs automatically on every captured URL: strips
  `token`, `email`, `phone`, `key`, `secret`, `password`, `auth` query params
  (case-insensitive). User-supplied `sanitizeUrl` runs on top of the default,
  never replacing it.
- PII guardrails: `ContextManager` blocks `email`, `phone`, `phoneNumber`,
  `name`, `firstName`, `lastName`, `fullName`, `username`, `password` keys
  from being promoted to `user.*` attributes even if passed through the
  index signature to `identify()`.
- Playwright end-to-end test suite running against a local mock ingest server.
  Covers envelope shape, auth headers, OTel absence, attribute flatness, and
  every event type end-to-end.

### Changed

- `app.environment` now defaults to `"production"` when not specified.
- `device.id` is persisted as a full ID in `localStorage` (not just the hex
  suffix), so it remains stable across calls and app restarts.
- `RouterCapture` and `IonicLifecycleCapture` now route `screen_view` and
  `screen_timing` events through an internal `recordEvent` path, so they are
  sent with their correct `eventName` instead of being wrapped as
  `custom_event`.
- The configured `endpoint` is automatically added to `ignoreUrls` so request
  capture never records the SDK's own send requests.

### Removed

- `email` field from the `UserContext` type. The field was already stripped
  from transmitted data; removing it from the type prevents autocomplete from
  suggesting it.

### Fixed

- `@capacitor/preferences` declared as an optional peer dependency in core
  (was previously dynamically imported but not declared).
- Test suite no longer emits unhandled promise rejections under fake timers
  (retry-transport tests).

## [0.1.0] — 2026-04-15

Initial public preview of `@nathanclaire/rum`, `@nathanclaire/rum-angular`, and
`@nathanclaire/rum-capacitor`.

### Added

- `EdgeRum.init()` with full configuration reference.
- Automatic capture of HTTP requests (fetch and XHR).
- Automatic capture of Angular route changes as `screen_view` events.
- Automatic capture of web performance data (page load, responsiveness, layout stability).
- Automatic capture of unhandled errors and promise rejections as `app.crash` events.
- Automatic capture of Ionic page enter / leave timing as `screen_timing` events.
- Automatic capture of app foreground / background transitions as `app_lifecycle` events.
- Automatic capture of network connectivity changes as `network_change` events.
- `EdgeRum.track()` for recording custom events.
- `EdgeRum.time()` for timing custom operations.
- `EdgeRum.captureError()` for recording handled errors.
- `EdgeRum.identify()` for attaching an opaque user ID to events.
- `EdgeRum.disable()` / `EdgeRum.enable()` for consent-driven control.
- Offline send buffering with automatic retry on reconnect.
- Default URL sanitiser that strips sensitive query parameters.
- Debug mode that logs every send with the API key redacted.

### Compatibility

- Ionic 7+, Angular 17+, Capacitor 6+.
- Sends data in the same JSON envelope as the companion Android SDK.

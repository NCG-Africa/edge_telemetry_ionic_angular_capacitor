# Changelog

All notable changes to the edge-rum SDK are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project follows
[Semantic Versioning](https://semver.org/).

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

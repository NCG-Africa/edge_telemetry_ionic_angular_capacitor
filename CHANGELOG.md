# Changelog

All notable changes to the edge-rum SDK are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Quick start, configuration reference, backend integration, and privacy documentation.
- `CHANGELOG.md` at the repo root.

## [0.1.0] — 2026-04-15

Initial public preview of `@edgemetrics/rum`, `@edgemetrics/rum-angular`, and
`@edgemetrics/rum-capacitor`.

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

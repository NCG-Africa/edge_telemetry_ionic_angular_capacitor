---
"@nathanclaire/rum": major
"@nathanclaire/rum-angular": major
"@nathanclaire/rum-capacitor": major
---

SDK-owned `user.id`, reshaped `identify()` API, and back-filled `device.*` / `app.*` context.

### Breaking changes

- **`UserContext` shape changed** to `{ name?, email?, phone? }`. Consumers calling `EdgeRum.identify({ id: '...' })` or passing custom keys will get a TypeScript error. Pass `name` / `email` / `phone` only; pass `null` to clear a field; pass `undefined` (or omit) to leave it untouched.
- **`user.id` is now SDK-owned.** It is auto-generated at `EdgeRum.init()` (`user_<ts>_<8hex>`) and persisted to `localStorage` so it survives reloads. Consumers cannot set or override it via `identify()`.
- **PII firewall removed.** Previously the SDK silently stripped `email`, `phone`, `name`, `username`, `password` from `user.*`. With the new identify shape, `user.name` / `user.email` / `user.phone` are sent as provided. Consumers are responsible for collecting consent and configuring backend retention. See `docs/privacy.md`.

### Fixed

- **`device.*` and `app.*` are now back-filled at flush time** for events recorded before Capacitor's device context loads (which previously meant `navigation`, `screen_view`, and `network_request` events emitted during the first ~100–300ms after `init()` had no `device.*`). Stable context (`app.*`, `device.*`, `sdk.*`) is back-filled; volatile context (`session.*`, `user.*`, `network.*`) stays captured-at-record-time.

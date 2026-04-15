# Architecture Decision Log

Append-only. Add a new entry whenever a significant or non-obvious architectural decision is made.

---

## ADR-001 — OTel as internal implementation detail only

**Date:** 2026-04

**Context:** We need a robust collection pipeline but do not want to couple the SDK's
public identity to OpenTelemetry.

**Decision:** Use `@opentelemetry/sdk-trace-web` internally, bundled and hidden. Zero OTel
types or concepts in the public API. CI grep check enforces this at the build artifact level.

**Consequences:**
- (+) Consumers insulated from OTel API changes — we can upgrade internally without breaking integrations
- (+) SDK brand identity is entirely ours
- (-) OTel adds ~150KB before tree-shaking. Mitigated by `tsup noExternal` tree-shaking
- (-) OTel major version changes must be absorbed internally

---

## ADR-002 — JSON-only wire format (no Protobuf)

**Date:** 2026-04

**Context:** OTLP supports Protobuf and JSON. Our backend is proprietary — not a standard
OTel collector. Protobuf would require `pako` for browser gzip and makes payloads opaque during debugging.

**Decision:** `Content-Type: application/json`. `JSON.stringify(payload)`. No compression.

**Consequences:**
- (+) Human-readable in network inspector and backend logs
- (+) No `pako` dependency — ~30KB smaller bundle
- (+) Backend receiver is trivial — plain JSON parse
- (-) ~20–30% larger on the wire vs Protobuf. At 2–15KB per payload at 5s intervals, negligible

---

## ADR-003 — Android SDK envelope compatibility

**Date:** 2026-04

**Context:** The backend already processes payloads from the Android SDK with a specific
Kafka processor. We could design a separate web endpoint with a cleaner format, or align
to the Android SDK structure.

**Decision:** Match the Android SDK envelope exactly:
```json
{ "timestamp": "<ISO8601>", "data": { "type": "batch", "events": [...] } }
```
Each event: `{ "type": "event", "eventName": "...", "timestamp": "<ISO8601>", "attributes": {...} }`.

**Consequences:**
- (+) Same Kafka processor, same storage tables, same dashboards — minimal backend work
- (+) Cross-platform queries work immediately (e.g. "crashes on iOS vs Android vs web")
- (-) We inherit the Android SDK's flat attributes design — all context repeated on every event.
  For a 10-event batch, `session.id` appears 10 times. Accepted — consistency outweighs efficiency
- (-) ISO 8601 timestamps required (not Unix ms). `new Date().toISOString()` is trivial

---

## ADR-004 — Flat attributes object — no nesting

**Date:** 2026-04

**Context:** The Android SDK uses a flat `attributes` object where every value is a primitive
(`string | number | boolean`). We could use nested objects for cleaner internal representation.

**Decision:** `attributes` must always be flat — `Record<string, string | number | boolean>`.
Flatten nested data with dot-notation keys at the instrumentation layer. Enforce with TypeScript
and a CI assertion on every test payload.

**Consequences:**
- (+) Identical to Android SDK — backend storage and queries work unchanged
- (+) Easy to index and query in columnar storage
- (-) Some data that's naturally nested (device info) must be flattened. This is a one-time
  cost in `DeviceContext.ts` — not an ongoing burden
- Implementation note: the TypeScript constraint `Record<string, string | number | boolean>`
  makes it impossible to accidentally pass a nested object

---

## ADR-005 — X-API-Key header (changed from original Authorization: Bearer design)

**Date:** 2026-04

**Context:** Our initial design used `Authorization: Bearer <apiKey>` as the auth header.
The Android SDK uses `X-API-Key: <apiKey>`. The backend validates the `X-API-Key` header.

**Decision:** Use `X-API-Key: <apiKey>` to match the Android SDK. The `apiKey` must start
with `"edge_"` — same validation rule as the Android SDK.

**Consequences:**
- (+) Same backend authentication path for both platforms
- (+) Same API key format and validation — one backend auth handler
- (-) Breaks our earlier documented design — CLAUDE.md and all transport code updated

---

## ADR-006 — eventName values aligned to Android SDK names

**Date:** 2026-04

**Context:** We could define web-specific event names (`navigation`, `request`, `vital`,
`error`) or align to the Android SDK's names (`screen_view`, `network_request`, `performance`,
`app.crash`).

**Decision:** Use Android SDK event names for all equivalent events. Web-only events
(`page_load`, `screen_timing`, `network_change`) use new names added to the schema.

**Mapping:**
- Angular route change → `screen_view` (same as Activity/Fragment navigation on Android)
- HTTP request → `network_request`
- Web Vital → `performance`
- JS error / crash → `app.crash`
- EdgeRum.track() → `custom_event`
- EdgeRum.time() → `custom_metric`
- App foreground/background → `app_lifecycle`

**Consequences:**
- (+) Backend can query `eventName = "screen_view"` and get results from all platforms
- (+) Crash processor handles `app.crash` from both Android and web with same field names
- (-) `app.crash` for JS errors is slightly misleading — a `TypeError` is not a "crash" in the
  traditional sense. Accepted — consistent with Android SDK intent

---

## ADR-007 — app.crash field alignment to Android SDK v2.0.0

**Date:** 2026-04

**Context:** The Android SDK v2.0.0 introduced specific crash field names: `exception_type`,
`message`, `stacktrace`, `is_fatal`, `error_context`, `is_fatal`, `cause`. Our initial design
used different names (`errorType`, `handled`, etc.).

**Decision:** Use Android SDK v2.0.0 field names exactly. Add one web-only field: `runtime`
(`"webview"` or `"native"`) to distinguish JS errors from native crash reports.

**Consequences:**
- (+) Same crash Kafka processor handles both platforms with minimal change
- (+) Crash dashboards show web crashes alongside Android crashes immediately
- (-) `handled` is web-only (Android doesn't send this field). Backend stores it; Android
  queries can ignore it

---

## ADR-008 — ZoneContextManager mandatory for Angular

**Date:** 2026-04

**Context:** Angular patches `Promise` and `setTimeout` via Zone.js. OTel's default context
manager also patches these, causing double-patching and context loss.

**Decision:** Always use `ZoneContextManager` from `@opentelemetry/context-zone`. Not configurable.

**Consequences:**
- (+) Async context works correctly in Angular components, services, and NgZone callbacks
- (-) If SDK is ever used without Angular, this manager is unnecessary overhead. Acceptable —
  this SDK targets Angular/Ionic only

---

## ADR-009 — OTel packages bundled, not peer deps

**Date:** 2026-04

**Context:** We could list OTel as peer dependencies (smaller bundle if consumer also uses OTel)
or bundle everything (zero-config install).

**Decision:** Bundle via `tsup noExternal: [/@opentelemetry\/.*/]`. Never a peer dependency.

**Consequences:**
- (+) `npm install edge-rum` and done — no OTel package names visible to consumer
- (+) Terminology firewall is structurally enforced
- (-) Two OTel copies if consumer already uses OTel. Acceptable for v1

---

## ADR-010 — Session expiry on 30-minute inactivity

**Date:** 2026-04

**Context:** Need a definition for when a session ends and a new one begins.

**Decision:** Session expires when app has been in background for > 30 minutes. Matches
Firebase Analytics, Amplitude, and Mixpanel convention.

**Consequences:**
- (+) Intuitive — maps to a user's occasion of use
- (-) User pausing 31 minutes mid-task gets a new session — industry standard tradeoff
- `lastActiveAt` stored in `@capacitor/preferences` — survives process kill

---

## ADR-011 — ID format matches Android SDK pattern

**Date:** 2026-04

**Context:** Our initial design used `ses_` + nanoid format for session IDs. The Android SDK
uses `session_{timestampMs}_{8hexchars}_{platform}`. Aligning them enables cross-platform
session stitching and consistent ID parsing on the backend.

**Decision:** Match Android SDK ID format:
```
device.id:   "device_{Date.now()}_{8hexchars}_{platform}"
session.id:  "session_{Date.now()}_{8hexchars}_{platform}"
user.id:     "user_{Date.now()}_{8hexchars}"
```
Platform is `ios`, `android`, or `web`.

**Consequences:**
- (+) Backend ID parsing works identically for both platforms
- (+) Platform is extractable from session/device ID without querying attributes
- (-) IDs are slightly longer than nanoid format. Negligible

---

## ADR-012 — session.sequence for dropped payload detection

**Date:** 2026-04

**Context:** Network conditions can silently drop payloads. Without detection, the backend
cannot distinguish "no events" from "events that never arrived".

**Decision:** Include `session.sequence` (monotonic integer, increments per sent payload)
on every event's attributes. Backend detects gaps.

**Consequences:**
- (+) Backend gains data quality visibility
- (+) Trivial to implement — one counter in SessionManager
- (-) Sequences from offline queue flush will appear out of chronological order. Backend must
  treat sequence as within-session ordering, not absolute time ordering

---

## ADR-013 — Three web-only event types added to the schema

**Date:** 2026-04

**Context:** `page_load`, `screen_timing`, and `network_change` have no Android equivalent
but are valuable for Ionic/web RUM.

**Decision:** Add as new `eventName` values. Fully documented in `docs/backend-changes.md`
so backend team knows what to expect. These are non-breaking additions — the Kafka processor
must simply not crash on unknown `eventName` values.

**Consequences:**
- (+) Richer data set for web/Ionic apps
- (+) Backend can handle gracefully even before implementing storage
- (-) Backend must be updated to fully process these — not blocking for launch
- (-) Three new event names to document and maintain

---

## ADR-014 — CORS required (new requirement vs Android SDK)

**Date:** 2026-04

**Context:** The Android SDK makes requests from native code — no CORS. The web SDK runs in
a WebView (Capacitor) and potentially in browsers. The same endpoint is used.

**Decision:** Document CORS as a blocking backend requirement. The endpoint must return
`Access-Control-Allow-Origin` and handle OPTIONS preflight. Listed as day-one blocker in
`docs/backend-changes.md`.

**Consequences:**
- (+) Web SDK works from browsers and WebViews without special handling
- (-) Backend must add CORS headers before the web SDK can be tested against production.
  Mitigated by using a local mock server during development

---

## ADR-015 — Source map symbolication is a new backend requirement

**Date:** 2026-04

**Context:** JS stacks in `app.crash` events are minified and unreadable without source maps.
Android native stacks are already human-readable. This is a new capability the backend needs.

**Decision:** SDK ships raw stacks. Backend implements async symbolication separately.
Documented in `docs/backend-changes.md` as medium priority (not blocking launch).

**Consequences:**
- (+) SDK stays simple — no in-browser symbolication complexity or bundle size overhead
- (+) Server-side symbolication is more reliable and maintainable
- (-) Crash reports for web are less useful until symbolication is implemented.
  Mitigated by `exception_type` + `message` + `cause` being human-readable even without the stack

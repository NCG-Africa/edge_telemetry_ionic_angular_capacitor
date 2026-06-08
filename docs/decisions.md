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

**Decision:** Match the collector server's expected envelope:
```json
{ "timestamp": "<ISO8601>", "type": "batch", "events": [...] }
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

---

## ADR-016 — Wire-contract realignment for EdgeTelemetryProcessor v3.0.0

**Date:** 2026-05

**Context:** ADR-006's mapping (`screen_view`, `network_request`, `performance`) was based on the
Android SDK v2 names. The EdgeTelemetryProcessor introduced a new dispatch (`event_processor.py`)
that branches on different names. Continuing to emit the old names meant the processor's per-event
handlers never fired and rollup tables stayed empty.

**Decision:** Rename to match the processor:

| Old (v3.0.0 → ADR-006) | New (v3.0.1 → ADR-016) |
|---|---|
| `screen_view` | `navigation` (entry hops) + `screen.duration` (dwell on exit) |
| `network_request` (with `network.*` attrs) | `http.request` (with `http.*` attrs) |
| `performance` event (Web Vitals) | metric item — `metricName: 'LCP' \| 'FCP' \| 'INP' \| 'CLS' \| 'TTFB'`, value at item root |
| outer envelope `type: "batch"` | `type: "telemetry_batch"` (and `attributes.app.package_name` instead of `app.package`) |

**Consequences:**
- (+) Processor handlers now route correctly — `rum_navigation_events`, `rum_screen_durations`,
  `rum_http_requests`, `rum_performance_metrics` all populate.
- (+) Metric items use the dedicated `{ type:'metric', metricName, value }` shape so Web Vitals
  go into the metric pipeline instead of `performance_events` catch-all.
- (-) This is a wire-breaking change vs ADR-006. Backend rollout coordinated; SDK and processor
  shipped together as v3.0.1.

---

## ADR-017 — EdgeRum.identify() emits user.profile.update

**Date:** 2026-05

**Context:** Before this change, `EdgeRum.identify()` only updated context attributes — no
dedicated event fired. The processor has a handler for `user.profile.update` that populates
`rum_users`, but the SDK never gave it a chance to fire.

**Decision:** Every `EdgeRum.identify()` call now emits one `user.profile.update` event with
a monotonic `user.profile_version` and `user.profile_updated_at`. Only the fields the caller
actually passed are echoed in the event payload (we don't re-emit prior name/email/phone if
they're unchanged).

**Consequences:**
- (+) `rum_users` populates correctly.
- (+) `profile_version` lets the backend dedupe rapid identify calls.
- (-) Critical event allowlist (ADR-019) ensures identify is never sampled out.

---

## ADR-018 — Session lifecycle events (session.started + session.finalized)

**Date:** 2026-05

**Context:** The processor has dedicated handlers for `session.started` and `session.finalized`
that manage the `rum_sessions` table. The SDK had the internal notion of a session (id, start
time, rotation) but emitted neither event, so `rum_sessions` was only populated incidentally.

**Decision:** Emit `session.started` at:
- SDK init (`start_reason: 'init'`)
- Foreground within the 30-min idle timeout (`start_reason: 'resumed'`)
- Foreground after the 30-min idle timeout, with id rotation (`start_reason: 'rotation_timeout'`)

Emit `session.finalized` at:
- Every background transition (`end_reason: 'backgrounded'`)
- App close via pagehide / beforeunload (`end_reason: 'app_closed'`) — shipped via
  `navigator.sendBeacon` (or sync XHR on iOS where sendBeacon is unreliable)
- On the rotation boundary itself the prior background's finalized already covered it, so
  no extra emission

Both routed through `Collector.recordEvent`; finalized uses the immediate-flush path so it
ships before the session id stops being valid.

**Consequences:**
- (+) Clean started/finalized pairs for every visible window — `rum_sessions` populates fully.
- (+) Session-level analytics (duration, drop-off rates) become queryable on the backend.
- (-) Brief background → foreground transitions emit a finalized + a started for the same
  session id — backend dedupes / upserts.

---

## ADR-019 — Per-session sampling + critical-event allowlist

**Date:** 2026-05

**Context:** Original `sampleRate` was per-event (`Math.random()` checked on every emit). At
`sampleRate: 0.1`, a session would get ~10% of its navigations, ~10% of its http requests, etc.
— fractional journeys that the backend can't distinguish from missing instrumentation. Worse,
the gate also dropped `app.crash` and `session.started`/`session.finalized`, so the backend
saw orphan events with no session boundaries.

**Decision:** Two changes:

1. **Per-session sampling.** Roll `Math.random() < sampleRate` ONCE at session start (and
   re-roll on rotation). Store the decision on `SessionManager`. The whole session is either
   fully captured or fully sampled out.

2. **Critical event allowlist.** `app.crash`, `session.started`, `session.finalized`, and
   `user.profile.update` always bypass the sampling gate. Backend never loses crashes or
   session boundaries.

**Consequences:**
- (+) Journeys are coherent — sampled-in sessions are complete, sampled-out sessions are
  empty (except for the four critical event types).
- (+) Crash and session counts are accurate regardless of sample rate.
- (-) `sampleRate: 0.5` no longer halves your bytes-on-the-wire exactly (~50% of sessions get
  full traffic, others get a sparse trickle of critical events). Acceptable.

---

## ADR-020 — Pipeline freeze + sendBeacon for pagehide

**Date:** 2026-05

**Context:** When the app closes (pagehide / beforeunload), we want to ship a final
`session.finalized: app_closed`. The Collector's `pushImmediate` triggers an async `flush()`,
but pagehide is a synchronous moment — the process may die before the flush resolves. We also
read the buffer via `getBeaconPayload()` to ship via `sendBeacon`, but the async flush could
drain the buffer first, racing the beacon.

**Decision:** Add `Pipeline.freeze()` / `Pipeline.unfreeze()`. The pagehide handler:
1. Calls `freeze()` — subsequent `push` / `pushImmediate` calls only buffer, never trigger
   the async `void this.flush()` kick.
2. Emits `session.finalized` (which goes through `pushImmediate` → just buffers).
3. Reads the buffer via `pipeline.buildBeaconPayload()` — synchronously serialises and drains.
4. Ships via `navigator.sendBeacon` (or sync XHR on iOS).

**Consequences:**
- (+) Deterministic delivery — no race between async flush and sync beacon.
- (+) No double-send.
- (-) New Pipeline API surface. Internal-only.

---

## ADR-021 — Wire-contract version on every event

**Date:** 2026-05

**Context:** SDK and processor are versioned independently. When the SDK ships event shapes
the processor doesn't yet know, events silently drop into the catch-all. Diagnosing version
skew required out-of-band coordination.

**Decision:** Every event carries `sdk.contract_version` (currently `'3.1.0'`) in its context
attributes. The processor can log "unknown contract" once per session if it doesn't recognise
the value. `SDK_VERSION` (`'3.5.0'`) is separate — it tracks SDK-internal versioning that may
not change the wire shape (e.g., a bug fix release doesn't bump the contract version).

**Consequences:**
- (+) Backend gains visibility into deployed SDK versions across the fleet.
- (+) Skew between SDK and processor becomes immediately diagnosable.
- (-) ~20 bytes per event for the field. Trivial.

---

## ADR-022 — Native crash bridge via Capacitor plugin

**Date:** 2026-05

**Context:** Until v3.2.0, the SDK only caught webview JS errors (`window.error`,
`unhandledrejection`, `console.error/warn`). Crashes from outside the webview — NSException,
Mach signals, JVM Throwables, NDK signals, ANRs — never reached JS and so never reached
the backend. For a "Capacitor RUM" claim to be credible, we needed native coverage.

**Decision:** Bundle a Capacitor plugin (`EdgeRumCrash`) into `@nathanclaire/rum-capacitor`.
The plugin wraps:

- **iOS:** PLCrashReporter (CocoaPods dependency) for signal-grade coverage + NSException +
  uncaught Swift errors. Plus a custom `HangDetector.swift` for main-thread liveness.
- **Android JVM:** `Thread.setDefaultUncaughtExceptionHandler` chained to the previous handler
  so the OS still gets the report.
- **Android ANR:** Custom Kotlin watchdog thread that posts heartbeats to the main `Looper`
  and captures stacks on >5 s blocks.
- **Android NDK:** Custom C++ `sigaction` handlers (SIGSEGV/SIGBUS/SIGILL/SIGFPE/SIGABRT) that
  write async-signal-safe binary records via `write(2)` to a pre-opened file descriptor.

All four paths persist crash records to disk on the dying process. On the **next** `EdgeRum.init()`,
the JS bridge calls `plugin.fetchPending()` and emits each as an `app.crash` event with
`cause: 'NativeCrash' | 'ANR' | 'Hang'`, `runtime: 'native'`, plus namespaced `crash.*` attrs.

**Consequences:**
- (+) Full crash coverage across web + native — single `app.crash` event surface, single
  Kafka processor.
- (+) `error_context: 'screen:<route>'` carries over to native crashes via a throttled relay
  from JS → native (`plugin.setLastScreen`).
- (-) Adds CocoaPods dependency on PLCrashReporter for iOS consumers.
- (-) Android requires NDK toolchain for the native signal handler (CMake build). Consumers
  who can't build NDK can disable via `captureNativeCrashes: false` — they lose only signal-class
  crashes; JVM + ANR still work.
- (-) Native code can't be unit-tested in this repo's CI — verification requires running the
  smoke tests on a real device. The risk is mitigated by leaning on PLCrashReporter (battle-tested)
  for the iOS path; only the Android NDK handler and Kotlin scaffolding are bespoke.

---

## ADR-023 — Wider ID entropy (8 → 16 hex chars)

**Date:** 2026-05

**Context:** ADR-011 set the random segment of `session.id` / `device.id` / `user.id` to 8 hex
chars (32 bits of entropy). Birthday-paradox collision probability at 1M IDs/day is non-negligible
within a tenant. For an SDK that's the source of truth on session id, we want stronger guarantees.

**Decision:** Widen the random segment to 16 hex chars (64 bits of entropy). Backend regex
patterns updated accordingly. Existing persisted IDs in localStorage are invalidated by the
stricter regex check on next launch — fresh IDs generate transparently.

**Consequences:**
- (+) Collision probability vanishes at any realistic scale.
- (+) Same `crypto.getRandomValues` path, just larger output buffer.
- (-) Persisted device/user IDs reset once on upgrade (one-time churn).
- (-) IDs are 8 chars longer on the wire. Negligible.

---

## ADR-024 — Breadcrumbs as JSON-string on app.crash

**Date:** 2026-05

**Context:** Crashes shipped with only `error_context: 'screen:/x'` — minimal forensic value.
Other RUM SDKs maintain a breadcrumb buffer (last N user actions) and attach it to crashes
for context. The challenge: ADR-004 enforces flat-primitive `attributes`, but the natural
representation of "last 20 actions" is an array of objects.

**Decision:** Maintain a ring buffer of 20 `{ ts, type, name }` records inside the Collector
(every non-crash event pushes a breadcrumb). On every `app.crash` emission, the snapshot is
serialised as **a single string** in `crash.breadcrumbs` (JSON.stringify of the array). The
schema documents this as the one and only exception to the flat-primitives rule. The backend
parses the string.

**Consequences:**
- (+) Crash forensics — backend can show "what was the user doing just before the crash".
- (+) No nested attributes on the wire; ADR-004 invariant preserved everywhere else.
- (-) Backend parses JSON inside a JSON attribute. Slight ergonomic cost vs a structured field.
  Accepted to avoid a wire-contract break.

---

## ADR-025 — User-interaction capture limited to tag/id/class/role (no inner text)

**Date:** 2026-05

**Context:** Click capture is high-value automatic instrumentation (rage-click detection,
funnel analysis). The natural temptation is to grab `target.textContent` for context ("which
button did they click?"). But form-adjacent text (labels, autocomplete suggestions, even
input values via DOM proximity) is a PII risk and a compliance burden.

**Decision:** Capture only `interaction.target_tag`, `interaction.target_id`,
`interaction.target_class`, `interaction.target_role` (with `aria-label` fallback). **Never**
read `textContent`. Consumers who want button-label tracking can add `data-*` attributes and
capture via explicit `EdgeRum.track()` calls.

**Consequences:**
- (+) Privacy-safe by default — no risk of leaking form field text.
- (+) Reduced PII review burden for compliance.
- (-) Funnel analytics that key on "clicked the 'Buy Now' button" require manual instrumentation.
  Tradeoff is intentional.

---

## ADR-026 — Per-flush opportunistic offline-queue drain

**Date:** 2026-05

**Context:** Before this change, the offline queue drained only on three triggers: network
reconnect, app foreground, or `EdgeRum.enable()`. If the SDK booted online but the very first
send failed (transient 5xx, CORS hiccup), the queue accumulated and never retried until one
of those triggers fired.

**Decision:** After every successful live `transport.send()`, kick off a non-awaited
`void this.flushOfflineQueue()`. Cheap because the queue's flush is a no-op when empty.

**Consequences:**
- (+) Transient outages self-heal — no waiting for foreground / network event.
- (+) Trivial implementation (one line).
- (-) Slight extra work per successful send (one empty-queue check). Negligible.

---

## ADR-027 — `frame_render_time` and `memory_usage` metrics

**Date:** 2026-05

**Context:** The EdgeTelemetryProcessor's `/sessions/{id}/performance` endpoint buckets frame
samples (good / slow / frozen / drop_rate) and renders a memory timeline. Both were empty for
SDK 3.3.x because the SDK never emitted the underlying `frame_render_time` or `memory_usage`
metrics. The processor team flagged Android session 82307 specifically as having zero rows in
`rum_performance_events`. They asked us to commit to a single attribute-key convention per
signal — they accept dotted or dotless but the Flutter SDK is already on dotless.

**Decision:**

1. Add two new metric items emitted by the SDK:
   - `frame_render_time` — one event per slow frame (default). Value = total interval in ms.
   - `memory_usage` — periodic (every `memorySamplingIntervalMs`, default 10s) plus on memory
     pressure callbacks and foreground/background transitions. Value = MB.
2. Use **dotless** attribute keys for these two metrics only (`unit`, `frame_build_duration`,
   `memory_pressure_level`, etc.). Existing metric emitters (`vitals.ts`, `perf-observer.ts`,
   `EdgeRum.time()`) keep their dotted (`metric.unit`) convention. Migrating existing dashboards
   to dotless isn't worth the wire-break.
3. **Three frame sources, one wire shape**:
   - WebView `requestAnimationFrame` (web + native fallback). Build = longest overlapping
     `PerformanceObserver({type:'longtask'})` entry; raster = max(0, total − build).
   - iOS CADisplayLink. Build = total, raster = 0 (CADisplayLink surfaces no sub-frame split).
   - Android Choreographer. Build = total, raster = 0 (same reasoning; FrameMetrics was not
     adopted because the plugin can't reliably attach to the host activity window).
4. **Slow-only by default**: only frames with total ≥ `frameSlowThresholdMs` (16.67ms) ship.
   `frame_dropped: true` when total ≥ 2x that threshold (a missed vsync at 60Hz). Both fields
   are always present and numeric; never null. `captureAllFrames: true` exists for debugging.
5. **Memory pressure mapping** (iOS / Android):
   - iOS `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE`: `.normal → "normal"`, `.warning → "moderate"`,
     `.critical → "critical"`. `"high"` is not produced on iOS.
   - Android `ComponentCallbacks2.onTrimMemory(level)`:
     `TRIM_MEMORY_RUNNING_MODERATE → "moderate"`, `TRIM_MEMORY_RUNNING_LOW → "high"`,
     `TRIM_MEMORY_RUNNING_CRITICAL` + `_COMPLETE` + `_BACKGROUND` + `_MODERATE` → `"critical"`,
     `TRIM_MEMORY_UI_HIDDEN` → `"normal"`, otherwise `"normal"`.
   - Web (`performance.memory`): no pressure signal → attribute omitted entirely. The processor
     omits the bucket rather than defaulting it.
6. **Native bridge**: extends the existing `EdgeRumCrash` plugin with four methods —
   `startPerfSampling`, `stopPerfSampling`, `fetchFrameSamples`, `fetchMemorySamples` — rather
   than registering a sibling plugin. Same single-plugin pattern the rest of the native bridge
   uses; minimises bridge surface.

**Consequences:**

- (+) Processor's `/sessions/{id}/performance` returns real data for new SDK sessions
  (frame buckets populated, memory timeline non-empty).
- (+) Wire contract honoured: `frame_build_duration` / `frame_raster_duration` are always
  numbers and `frame_dropped` is always boolean — no null fallbacks.
- (+) Volume safe by default: idle screens emit zero frame events; a constant 30fps animation
  emits ~30 events/sec only while it runs.
- (−) The build/raster split on iOS / Android is approximated (total / 0). The processor's
  per-bucket aggregation still works because `frame_dropped` and total `value` drive it; the
  per-thread breakdown isn't faithful on non-Flutter platforms. Documenting in the schema is
  enough for now; we revisit FrameMetrics integration when the processor needs more.
- (−) `lastPressure` on iOS / Android is sticky between events — a critical event keeps
  influencing samples until the next normal callback. Acceptable: pressure events are sparse
  and the processor only uses the highest pressure observed per session.

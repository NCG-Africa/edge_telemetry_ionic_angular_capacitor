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

---

## ADR-028 — Bounded buffer + off-hot-path retry seam (Candidate 01)

**Date:** 2026-07

**Context:** `Pipeline.buffer` was an uncapped array, and `flush()` held the `flushing` gate
while `RetryTransport.send()` walked the full `[0, 2s, 8s, 30s]` ladder inline (~40s per failing
batch). During a backend brownout the gate stayed held while `push()` piled events into the
buffer unbounded — the memory monitor grows, worst case OOMs the host it is supposed to be
observing. There were effectively two buffers: the uncapped live `buffer` and the already-capped
`OfflineQueue` (200 batches, drop-oldest FIFO). This is the root amplifier the other
operational-safety candidates feed into. Resolves ticket #44.

**Decision:**

1. **Fail-fast flush, one paced background drain owns the ladder.** `flush()` attempts each
   batch **once** — a single POST, no inline backoff. Any non-success routes straight to
   `OfflineQueue`. The `[2s, 8s, 30s]` backoff moves entirely off the flush path into a drain
   scheduler. This collapses "failed live batch" and "already-queued batch" into one retry path
   and removes the ~40s gate that was the actual root cause.
2. **`RetryTransport` → stateless `sendOnce()`.** It does one POST and classifies the result as
   `ok` / `retryable` (carrying any `Retry-After`) / `fatal`. It no longer sleeps; all timing
   lives in the drain.
3. **Bounded live buffer.** `Pipeline.buffer` becomes a bounded array (not a ring — the buffer
   is small and short-lived under fail-fast flush; a ring is premature). Overflow **drops
   oldest** (FIFO), matching `OfflineQueue` so the SDK tells one story: under pressure, freshest
   data wins. Crash/error events bypass this via `pushImmediate`. Cap = **`batchSize × 10`**
   (default 300 events), an **internal constant**, not a public config field. `maxQueueSize`
   (200 batches) stays the one user-facing volume knob.
4. **Drop self-report.** Both caps discard silently otherwise. Introduce a single monotonic
   per-session counter surfaced as **`sdk.dropped_count`** on `session.finalized` (which already
   rides immediate-flush and carries `sdk.error_count`), plus a debug-mode `console.warn` on each
   drop. One total (live-buffer + queue combined); the debug log names the source. No new
   `eventName`.
5. **Drain ownership & pacing.** The drain scheduler (backoff state + `setTimeout`) lives in
   **`OfflineQueue`** — it owns the persisted batches and the retry lifecycle. `Pipeline` feeds
   failed batches in and pokes the drain. On a `retryable` result the drain walks `[2s, 8s, 30s]`
   then **holds at 30s**, honoring `Retry-After` when present (it overrides the step), resetting
   to fast on any success. `fatal` (non-retryable 4xx) batches are dropped immediately and
   counted toward `sdk.dropped_count`. **No artificial gap between successful sends** — the drain
   runs contiguously: bursting POSTs lets the cellular radio return to idle sooner (better for
   battery than a throttled drip), and the backend's own `429`/`503`+`Retry-After` is the real
   backpressure valve.
6. **Zero new `EdgeRumConfig` fields.** The whole deepening rides existing knobs (`batchSize`,
   `maxQueueSize`) and internal constants. Its only wire-shape output is the `sdk.dropped_count`
   attribute.

**Consequences:**

- (+) The ~40s flush gate is gone; a brownout can no longer grow the live buffer unbounded.
  Memory stays bounded by `batchSize × 10` live + `maxQueueSize` queued.
- (+) No request stampede: one paced drain instead of N concurrent inline ladders.
- (+) Data loss is no longer silent — `sdk.dropped_count` makes "the app is too chatty" visible
  and distinct from `sdk.error_count` ("the SDK is buggy").
- (+) No public config growth — a backpressure fix that adds no surface consumers must reason about.
- (−) `sdk.dropped_count` is a new wire attribute → needs backend-team confirmation and a
  `docs/payload-schema.json` update before implementation ships (tracked by the map's
  config-consolidation fog item).
- (−) Fail-fast flush means a single transient failure sends a batch to the offline queue rather
  than retrying inline — one extra persist/drain round-trip on flaky-but-recovering networks.
  Acceptable: the drain reclaims it within the first backoff step, and the alternative was the
  40s gate.

## ADR-029 — Console noise → breadcrumbs, never `app.crash` (Candidate 02)

**Date:** 2026-07

**Context:** `captureConsoleErrors` defaults on and wrapped **both** `console.error` and
`console.warn`, each calling `recordEvent('app.crash', …)`. Because the eventName is literally
`app.crash`, every console line landed in **both** `CRITICAL_EVENT_NAMES` (bypasses `sampleRate`,
`collector.ts:9`) and `IMMEDIATE_FLUSH_EVENT_NAMES` (synchronous `pushImmediate → flush()`,
`collector.ts:8`). So a chatty dependency = one un-sampled **immediate POST per log line**: it
floods the crash dashboard, and it double-counts real errors (the window `error` handler fires,
then a framework re-`console.error`s the same throwable). This is the amplification feeding the
bounded-buffer/backpressure fix in ADR-028. Resolves ticket #45.

**Decision:**

1. **Route to breadcrumbs only — no standalone event, no POST.** Captured console output stops
   emitting `app.crash` (or any event). It pushes a breadcrumb into the existing ring instead, so
   it rides along inside the next genuine `app.crash`'s `crash.breadcrumbs` (ADR-024). Console
   noise costs zero network and zero un-sampled traffic; it becomes crash *context*, not a crash.
2. **`app.crash` reserved for genuine crashes.** With console de-routed, the `CRITICAL` and
   `IMMEDIATE_FLUSH` sets are **unchanged** — both stay `{app.crash, session.finalized}` (plus the
   `CRITICAL`-only `session.started`, `user.profile.update`). `app.crash` now means only: uncaught
   error, unhandled rejection, native crash. Nothing console-sourced is immediate or sampling-exempt.
3. **Double-count dissolves.** A framework's post-throw `console.error` re-log of an uncaught
   exception is now just another breadcrumb, not a second immediate `app.crash`. No dedup logic
   between the `error` handler and the console wrapper is needed — the two can no longer both mint
   an event.
4. **Rate-limit console breadcrumbs so they don't evict the action trail.** The ring keeps only
   the last 20 actions; an unbounded console-spam loop would push every navigation/interaction
   crumb out before a crash, leaving `crash.breadcrumbs` full of noise. **Collapse consecutive
   duplicate** console breadcrumbs (same level + message) into a single crumb carrying a `count`,
   rather than pushing one crumb per line. The dedup key is `level + message`; a non-matching line
   starts a fresh crumb. (Implementation may additionally cap console crumbs per rolling window;
   the collapse is the required behaviour.)
5. **`captureConsoleErrors` stays default `true`, but wraps `console.error` only.** `console.warn`
   is **no longer captured at all** — low signal as a crash-trail crumb. The internal `captureWarn`
   sub-option on `ConsoleErrorDeps` is removed. The public flag keeps its name and default, but its
   semantics change: it now means "add `console.error` lines to the crash breadcrumb trail," not
   "capture console output as crashes."

**Consequences:**

- (+) A chatty dependency can no longer generate un-sampled immediate POSTs — the single biggest
  console-driven amplifier is gone. The crash dashboard stops filling with non-crashes.
- (+) Real crashes are counted once; `sdk.error_count` and the crash dashboard stop double-counting
  the handler + re-log pair.
- (+) Console lines survive as crash *context* exactly where they're useful — inside the breadcrumb
  trail of the crash they preceded — without their own network cost.
- (+) **No new wire event and no `docs/payload-schema.json` change**: breadcrumbs-only means no new
  `eventName` and no new attribute on the wire. (Contrast ADR-028's `sdk.dropped_count`.)
- (−) **Behaviour change on upgrade:** `console.error`/`console.warn` no longer surface as
  standalone `app.crash` events, and `console.warn` is dropped entirely. Consumers who relied on
  console lines appearing as crashes lose that; they appear only in `crash.breadcrumbs` now. The
  `captureConsoleErrors` semantics shift and the removed `captureWarn` behaviour are noted for the
  map's config-consolidation fog item.
- (−) A crash that is *not* preceded by any genuine error handler firing (pure console-only
  failure) produces no telemetry at all. Accepted: console output is not a crash, and the cardinal
  rule is that the monitor must not degrade the app it watches.

## ADR-030 — Frame monitor aggregation, one summary per window (Candidate 03)

**Date:** 2026-07

**Context:** `registerFrameCapture` runs `raf(tick)` forever and, at the default
`sampleRate = 1.0`, emits a `frame_render_time` metric for **every** frame slower than
16.67ms — dozens per second during a scroll or an Ionic page transition. Each emit does a
~30-key `getContextAttributes()` spread plus a buffer push, so measuring frame health is the
thing that worsens it (the observer effect). This is the frame-side amplifier paired with the
console amplifier (ADR-029) and the backpressure fix (ADR-028). The rAF loop must stay — it is
the only way to see WebView frames — but it must accumulate rolling stats instead of emitting
per frame. Resolves ticket #46.

**Decision:**

1. **Aggregate into a rolling window; emit one summary per window.** The rAF `tick` observes
   **every** frame (needed for the denominator) and appends the frame duration to an in-window
   buffer. No per-frame emit. One `metric` item is produced when the window closes.
2. **Window boundary — screen exit OR `MAX_WINDOW_MS`, whichever first.** A window belongs to
   one screen: it closes and emits when the route changes, and also force-closes after a fixed
   time cap so a long-lived screen (a feed scrolled for minutes) produces several summaries
   instead of one coarse blob. The screen-exit trigger is implemented **inside `tick`** — each
   tick reads `getCurrentRoute()`; a change from the window's route closes the current window,
   emits, and opens a fresh one. No new cross-package wiring (the web core has no screen-exit
   callback today; polling the route in the loop avoids adding an interface into
   `packages/angular`). `MAX_WINDOW_MS` is an **internal constant = 30000ms**. `dispose()`
   (SDK `disable()` / session end) flushes any in-progress window too — a third, teardown-only
   close trigger so a screen's jank isn't silently lost; it obeys the same emit-only-when-slow
   suppression, so a smooth window still sends nothing.
3. **Emit only when `slow_frames > 0`.** A window that closes with no slow frame (a smooth
   screen) is **suppressed entirely** — this is where the volume cut lives; a smooth app sends
   near-zero frame metrics. Absence of a summary therefore means "smooth **or** never measured";
   there is deliberately no positive smooth-screen signal and no fleet-wide smoothness
   denominator. Truly empty windows (`frames_total == 0`, e.g. backgrounded) are likewise
   skipped.
4. **Summary shape — `metric` item, `metricName = "frame_render_time"`, dotless attributes.**
   The item shape and metric name are unchanged from ADR-027; the **attribute set changes**. The
   top-level numeric `value` is the window **p95** frame duration (ms). Attributes (dotless per
   `CLAUDE.md`):
   - `frames_total` — all frames observed in the window (the denominator)
   - `slow_frames` — count ≥ `slowThresholdMs`
   - `dropped_frames` — count ≥ `slowThresholdMs × 2`
   - `p50_ms`, `p95_ms`, `worst_ms` — percentiles/max over **all** frames in the window
   - `window_ms` — wall-clock span of the window
   - `metric.screen` — the route the window belongs to (unchanged key)

   Percentiles are computed over all frames (not only slow ones): a p95 near the threshold reads
   as healthy, a high p95 reads as jank. Implementation: buffer durations, sort once on flush —
   bounded by the window (≤ 30s ≈ ≤ ~1800 frames), so no streaming estimator is needed.
5. **Build/raster split dropped.** `frame_build_duration` / `frame_raster_duration` (the
   longtask-overlap signal) were per-frame concepts with no meaningful aggregate; they are
   removed from the wire, not aggregated. The longtask observer may be removed or retained purely
   internally — it no longer feeds any emitted attribute.
6. **Zero new `EdgeRumConfig` fields.** `slowThresholdMs` already exists; the max-window cap is an
   internal constant (decision 2). The `captureAllFrames` dep/test-seam becomes redundant under
   the aggregate-and-suppress model (all frames are always observed for `frames_total`; healthy
   windows are always suppressed) and is removed from the emit path — noted, like ADR-029's
   `captureWarn` removal, for the config-consolidation fog item.

**Consequences:**

- (+) The single largest frame-side amplifier is gone: a scroll or transition that produced
  dozens of immediate emits per second now contributes at most one summary per screen (and none
  at all if it stayed smooth). The context-spread + buffer-push cost drops from per-frame to
  per-window.
- (+) One summary tells the whole jank story for a screen — `dropped_frames / frames_total`, the
  distribution (p50/p95/worst), and how long the window ran — which is richer *per emit* than the
  old single-frame records while being vastly fewer events.
- (−) **Wire-shape change, needs backend confirmation.** The `frame_render_time` attribute set
  changes (new: `frames_total`, `slow_frames`, `dropped_frames`, `p50_ms`, `p95_ms`, `worst_ms`,
  `window_ms`; removed: `frame_build_duration`, `frame_raster_duration`, `frame_type`,
  `frame_dropped`). Per `CLAUDE.md` this requires backend-team sign-off and a
  `docs/payload-schema.json` update before implementation — tracked by the map's frame-metric
  wire-shape fog item.
- (−) **Native-sampler divergence until aligned — now resolved.** The iOS (`FrameSampler.swift`,
  #54) and Android (`FrameSampler.kt`, #55) samplers originally shipped **per-sample**
  `frame_render_time` with the old `build_ms`/`raster_ms`/`dropped` attributes. Both are now on the
  windowed-summary shape, so web+iOS+Android emit byte-compatible summaries for the same metric name
  (Kafka parity). Window boundary on native closes on JS route change (relayed via `setLastScreen`),
  a 30s cap, backgrounding (iOS `didEnterBackground`, Android `handleOnPause`), or stop. `#49`'s
  schema tolerated both shapes during the migration window.
- (−) No positive smooth-screen signal (decision 3): dashboards cannot compute a fleet smoothness
  percentage from these metrics, because healthy windows emit nothing. Accepted: the cardinal rule
  is that the monitor must not degrade the app, and per-frame emission on every smooth frame is
  exactly the degradation being removed.

## ADR-031 — HealthMonitor circuit breaker: dispose a throwing capture (Candidate 04)

**Date:** 2026-07

**Context:** `HealthMonitor` is a passive tally. ~20 capture hooks funnel caught errors to
`reportError(scope, err)`, which bumps `errorCount` + `byScope[scope]` and (in debug) warns —
but nothing *acts*. If one instrumentation throws on every event, the SDK increments forever and
keeps paying the cost, silently degrading the host it is meant to observe. The seam to fix this
already exists on the *action* side too: every capture's `register*` returns a handle with an
idempotent `dispose()`, and `EdgeRum` already stores each handle centrally
(`state.framesHandle`, `state.interactionsHandle`, …). What's missing is the trip logic and a
mapping from a throwing scope to the handle that owns it. This is the operational-safety pair to
ADR-028/029/030 — it counts wounds; this ADR applies the tourniquet. Resolves ticket #47.

**Decision:**

1. **Trip and dispose per-capture.** The breaker's unit is the whole capture, not the fine-grained
   scope string. Scope → capture name = the substring **before the first `.`** (`frames.emit`,
   `frames.longtask.setup`, `frames.disconnect` all map to `frames`). Any scope under a capture
   contributes to that capture's counter; tripping disposes the capture's one handle. Per-scope
   disposal was rejected — most call sites own no independently-teardownable resource, and the only
   teardown seam that exists is per-capture.
2. **Trip policy — 5 consecutive failures, reset-on-success, no time window.**
   `const DISPOSE_AFTER_CONSECUTIVE_FAILURES = 5`. Each capture tracks a *consecutive* throw count;
   any successful event for that capture resets it to 0. Only an unbroken run of 5 failures with no
   successful event between them trips. This precisely catches the ticket's target failure ("throws
   on every event") while auto-forgiving a capture that recovers. A rolling time-window model was
   rejected: it would put per-error timestamp bookkeeping on the very hot path ADR-028 just worked
   to keep clean, and consecutive-count already catches always-throwing captures. Cumulative-count
   was rejected: it eventually trips healthy-but-occasionally-flaky captures over a long session.
3. **Zero new `EdgeRumConfig` fields.** N is an internal constant. A consumer has no basis to tune
   "5 vs 8 consecutive throws," and the fail-open guarantee (decision 5) means a wrongly-disposed
   capture only goes quiet — strictly safer than exposing a knob someone could set to `Infinity` and
   re-break the thing being fixed. Consistent with ADR-028/029/030, all of which added no config. If
   a real need for a master off-switch emerges, a single `boolean` is the cheapest later add — YAGNI
   until then.
4. **Registration seam — captures register a dispose callback with `HealthMonitor`.** New method
   `healthMonitor.registerCapture(name, dispose)`. `EdgeRum` registers each handle's dispose at
   startup next to where it already stores the handle (e.g.
   `registerCapture('frames', () => state.framesHandle?.dispose())`). When `reportError` pushes a
   capture's consecutive count to N, `HealthMonitor` calls that registered dispose **itself**, flips
   the capture to disposed, and stops counting it. Count and action live together in the one seam
   that already owns the error signal — "hit N → dispose → stop counting" is atomic and unit-testable
   (register a spy dispose, assert it fires at exactly the 5th consecutive throw). Alternatives —
   a `getTrippedCaptures()` set polled by EdgeRum (no natural tick to poll on) and a `shouldDispose`
   return from `reportError` (scatters breaker logic across ~20 call sites that don't hold their own
   handle) — were rejected.
5. **Dispose contract — idempotent, try/caught, disposed-means-disposed.** `dispose()` must unhook
   listeners, stop timers/loops, and be a no-op on second call (`disable()` / session rotation may
   also invoke it — already true of current handles; now a stated contract). The breaker's dispose
   call is wrapped in try/catch: if a capture's own teardown throws, the breaker swallows it
   (debug-warn only), **still** marks the capture disposed, and **never** rethrows. Fail-open is the
   ticket's hard requirement — a capture already throwing on every event is exactly the one whose
   teardown might also throw, so a tourniquet that could itself propagate would crash the host at the
   moment it's protecting it. Disposed-means-disposed regardless of teardown outcome, because either
   way the breaker stops calling into the capture.
6. **Recording — reuse `sdk.error_count`, add `sdk.disposed_captures` on `session.finalized`.** The
   raw tally stays `sdk.error_count` (unchanged). A new flat primitive attribute
   `sdk.disposed_captures` — comma-joined capture names (`"frames,interactions"`, `""` if none) —
   is added to `session.finalized`, the event that already carries `sdk.error_count` and (ADR-028)
   `sdk.dropped_count`. No new `eventName`, no new event, no immediate flush. A disposed capture is a
   material degradation of the data the backend receives for the rest of the session and deserves a
   distinct named signal ("this install lost frame monitoring") — but not its own event, and
   emphatically not an immediate POST, which would re-introduce the amplification this whole map
   fights. A dedicated real-time trip event was rejected for exactly that reason.
7. **Permanence — per-session terminal.** Once disposed, a capture stays down for the session (its
   handle is gone). A fresh session (rotation / next launch) re-inits all captures clean. This falls
   straight out of "dispose the handle," so `sdk.disposed_captures` describes the whole session at
   finalize time.

**Consequences:**

- (+) The last operational-safety amplifier is closed: an instrumentation that breaks under a
   specific device/OS/page condition is amputated after 5 consecutive throws instead of throwing
   (and being caught, and counted, and debug-warned) on every subsequent event for the session's
   life. The host stops paying that cost.
- (+) Reuses the two seams that already exist — `reportError(scope, …)` on the sensing side and the
   per-capture `dispose()` handles on the acting side — so the change is a small counter + a
   `registerCapture` map in `health.ts` plus a handful of registration lines in `EdgeRum`, not a
   refactor of the ~20 call sites.
- (−) **Wire-shape change, needs backend confirmation.** `sdk.disposed_captures` is a new
   `session.finalized` attribute. Per `CLAUDE.md` it needs backend-team sign-off and a
   `docs/payload-schema.json` update — folds into the *same* pending `session.finalized` update as
   ADR-028's `sdk.dropped_count` and ADR-030's frame-shape change (config-consolidation fog item).
- (−) A capture disposed early in a long session produces no data for the rest of it, and (decision
   3) the consumer cannot turn the breaker off. Accepted: the cardinal rule is the monitor must not
   degrade the host, and a capture throwing on every event *is* that degradation — going quiet is the
   safe failure. `sdk.disposed_captures` makes the silence legible rather than mysterious.

**Follow-on notes (not new decisions — consequences of the above):**

- Registration-time errors (`console.register`, `interactions.register`, `perf-observer.register`
   in `EdgeRum`) that report under a capture name never registered with the breaker just tally
   `error_count` and no-op the breaker — a `reportError` for an unregistered name is harmless.
- `HealthMonitor.reset()` must now also clear registered captures, the per-capture consecutive
   counters, and the disposed set (alongside the existing `errorCount` / `byScope` reset).
- Reset-on-success (decision 2) needs a per-capture success signal, which the error seam alone can't
   supply. Implemented as `healthMonitor.reportSuccess(scope)` called at each registered capture's
   hot emit success point (`frames.emit`, `memory-web.emit`, `interactions.click`,
   `perf-observer.longtask.emit` / `.resource.emit`, `errors.capture`, `console.emit`) — the ~6 emit
   sites, not the ~20 error-report sites. Without it the counter would drift to cumulative, the model
   decision 2 explicitly rejected.

---

## ADR-032 — Per-session health tallies reset on session rotation (#58)

**Date:** 2026-07

**Context:** `HealthMonitor` is a process-scoped singleton; its `errorCount` / `droppedCount`
were only zeroed by `reset()` (init-time / test-reset), never on session rotation. ADR-028
dec.4 specifies a *per-session* counter, but on mobile the JS context survives
background→foreground, so a session rotated in-process (`session.started` `rotation_timeout`
after >30 min idle) would report the cumulative process-lifetime `sdk.error_count` /
`sdk.dropped_count` on its `session.finalized`, not just its own. The dominant lifecycle
(finalize-then-kill) was unaffected, which is why this was deferred out of #50. Resolves #58.

**Decision:**

1. **New `healthMonitor.resetSessionTallies()`** zeroes `errorCount`, `droppedCount`, `byScope`
   only. `reset()` now delegates to it, then additionally clears the ADR-031 breaker state.
2. **Called when a genuinely new session begins — init + `rotation_timeout`, NOT resume.**
   `EdgeRum.init()` calls it (no-op on a first-process init; matters on in-process re-init).
   `LifecycleCapture` calls it via a new optional `resetSessionHealth?()` callback on the same
   `rotation_timeout` branch that calls `startNewSession()`. A resumed session keeps its tallies.
3. **ADR-031 breaker state deliberately survives rotation.** The disposed set, disposers, and
   consecutive-run counters are left intact — a disposed capture is physically torn down and stays
   dead across the rotation, so `sdk.disposed_captures` continues to report it and a fresh throw
   never re-disposes it. Only the two per-session tallies are scoped to the session.

---

## ADR-033 — Terminology firewall narrowed to OpenTelemetry identity; `trace`/`span` allowed (#75)

**Date:** 2026-10

**Context:** ADR-001 hid OpenTelemetry from the public surface. `CLAUDE.md` Rule 1 and
`docs/terminology.md` went further and banned the generic words `span` / `trace` / `tracing`.
edge-rum 5.0 adopts distributed trace v3 (map #68; `docs/research/trace-v3-for-webview.md`):
dotted `trace.id` / `span.id` / `traceparent.outcome` on `http.request`, a W3C `traceparent`
header, and a host allowlist that consumers must configure and whose CORS requirement docs must
explain. W3C trace context is a standard, not OTel. Every sibling (RN, Android, Flutter) names
its allowlist `traceHostAllowlist`. Partially supersedes ADR-001's "zero OTel concepts" wording
and Rule 1's `span / trace` row.

**Decision:**

1. **Firewall protects OTel / vendor identity only.** Still banned in public surface:
   `opentelemetry`, `otel`, `otlp`, `TracerProvider`, `SpanProcessor`, `SpanExporter`,
   `MeterProvider`, `LoggerProvider`, `tracer`. `trace`, `span`, `tracing`, `traceparent`
   become ordinary consumer vocabulary (API names, docs, errors, debug output).
2. **Only `trace`/`span` are freed.** The other non-OTel bans (`telemetry`, `metric(s)` in API
   names, `instrumentation`, `sampling`, `batch`, `flush`, `collector`, `pipeline`, …) stay —
   brand voice, unchanged.
3. **Config key is `traceHostAllowlist`** (family parity). Value shape is decided in the public
   API ticket (#80).
4. **Guard tests afterwards:**
   - `scripts/terminology-check.mjs` (`.d.ts` grep) — unchanged; already OTel-only.
   - `test/docs-terminology.test.ts` — drop `span` / `tracer` / `tracing` from the banned list;
     add `tracer` back only as part of the OTel set (`TracerProvider` etc.); keep the rest.
   - Payload tests keep banning camelCase `traceId` / `spanId` / `resourceSpans` /
     `opentelemetry` as the OTel-leak guard (dotted keys never collide).
   - New payload test pins dotted `trace.id` / `span.id` / `traceparent.outcome` on
     `http.request`.

**Consequences:**
- (+) Consumer docs can name `traceparent` and explain the CORS allowlist plainly.
- (+) One config name across the SDK family.
- (−) `CLAUDE.md` Rule 1, `docs/terminology.md` and the docs test must be edited in the 5.0
  implementation — until then they are stale on `span`/`trace` only.

---

## ADR-034 — Contract 4 fit: native core owns identity, outbox and send; web is a no-op (#76)

**Date:** 2026-10

**Context:** edge-rum 5.0.0 moves from the legacy `telemetry_batch` 3.1 wire to contract 4
(`edge_rum/wayfinder/spec.md` R1–R16, S1). Gap inventory (`docs/research/ionic-gap-inventory.md`
§2): 7 rules missing (R3, R7, R8, R12, R13, R14, R16), 4 renames. Today JS owns identity
(localStorage), the queue (serialised bodies in localStorage) and the sender; native code only
captures (crash, ANR/hang, frames, memory). Several gaps — 5xx dropped, queued bodies replayed
with a stale timestamp (R13), keyless `sendBeacon`, crash replayed with the current build (R14),
queue lost on WebView storage wipe — come from send living in JS. The closest sibling, Cordova,
already moved native (Cordova spec A1, A8, W1–W4).

**Decision:**

1. **Native core owns** config prefs, app identity, `device_id`, the outbox, the sender and the
   8-key contract-4 envelope, on Android and iOS — a port of the Cordova native core. JS owns
   WebView/Angular/Ionic capture and an in-memory buffer handed to native. The JS
   `PayloadBuilder` / `RetryTransport` / `OfflineQueue` / `sendBeacon` path is removed. This
   realizes R3, R12, R13, R14 by construction. Where session state and sampling sit is decided
   with the architecture ticket (#78), defaulting to Cordova A1 (native).
2. **Web is a silent no-op** (R16, Cordova A8): every method exists, nothing is captured or sent,
   one debug-mode warning. `device.platform=web` is gone.
3. **App identity is native only, no override** (Cordova W3): Android `PackageManager`
   (`applicationId`, `versionName`, `versionCode`); iOS `Bundle.main` (bundle id,
   `CFBundleShortVersionString`, `CFBundleVersion`). `app.platform` = `android`|`ios`. Nil → key
   omitted (R15). `EdgeRumConfig.appName` / `appVersion` / `appPackage` / `appBuild` are removed.
4. **`device_id`** (R9) per Cordova W4: Android = `IdGenerator` port (SharedPreferences UUID,
   persisted fallback pinned per process, in-memory last resort); iOS = Keychain, UserDefaults
   fallback. Never JS/localStorage. **No carry-over** of the 4.x `device_<ms>_<hex>_<platform>`
   id: a fresh UUID on the first 5.0 launch; the old localStorage key is deleted.
5. **Header values** fixed by contract: `sdk.name = "ionic"` (R2), `contract_version = "4.0.0"`
   (R11/S1), `sdk.version` = package version `5.0.0`. `sdk.platform`, `location` (R7) and
   `app.environment` (R8) stop being sent; `location` / `resolveLocation` /
   `locationProviderUrl` / `environment` leave the config (exact API shape: #80).

**Not decided here:** whether the native sender gzips (Cordova does; `CLAUDE.md` Rule 2 bans
compression) — goes to the architecture/budget ticket (#78).

**Consequences:**
- (+) Send-policy bugs fixed structurally; outbox survives WebView death and storage wipes.
- (+) JS bundle shrinks (pipeline, queue, payload builder, location resolver removed).
- (+) Identity cannot drift from the store binary; key binding always matches.
- (−) Largest native diff in the SDK's history (two native cores); Cordova code is the template.
- (−) Ionic web/PWA monitoring ends.
- (−) Device counts jump once at upgrade (new UUIDs).
- (−) 5.0 config break: app identity, `location*` and `environment` keys removed.
- Supersedes the ID-format, envelope and offline-queue sections of `CLAUDE.md`, and the related
  ADRs on localStorage identity and the JS offline queue, at 5.0 implementation time.

---

## ADR-035 — Trace model: ambient root, fetch+XHR injection, native crash annotation (#77)

**Date:** 2026-10

**Context:** 5.0.0 adds distributed trace v3. The wire is frozen by Android and adopted verbatim
by iOS (`docs/research/trace-v3-for-webview.md` §1.1). The mechanism is each SDK's own call. Ionic
runs single-threaded WebView JS. Zoneless is the Angular default from v21, so Zone.js cannot be
the base carrier. Every API call from `capacitor://localhost` / `https://localhost` is
cross-origin, so `traceparent` triggers a CORS preflight. ADR-033 frees `trace`/`span` and names
the config key `traceHostAllowlist`. ADR-034 makes web a no-op, so there is no web-mode injection.

**Decision:**

1. **Carrier = ambient root only** (option (a); RN/Android/Flutter/iOS model). One mutable root
   is read synchronously inside the patches. Expiry is lazy: 2 s idle, 10 s cap; the idle clock
   extends on child start and on request completion. No Zone.js read, no explicit public
   override, no AsyncContext (a feature-detected upgrade later, if it ships).
2. **Root types:** `launch`, `interaction`, `navigation`, `request`, `resume` (Android 4 + the
   iOS `resume`). No `custom`.
3. **Mint points:**
   - `launch`: start = `performance.timeOrigin`. Exempt from idle expiry until the first resume.
   - `interaction`: document capture-phase click, before the app handler. Always replaces the
     live root. A click deduped by the 50 ms window does not mint.
   - `navigation`: Router `NavigationStart`, **only when no root is live** (a tap that navigates
     keeps the tap root; guard/resolver requests parent to it). `ionViewWillEnter` does not mint.
   - `request`: a request when no root is live.
   - `resume`: Capacitor `appStateChange` → active.
4. **Injection = global `fetch` + `XMLHttpRequest` patches only.** These cover `HttpClient` on
   either backend and CapacitorHttp-enabled apps (the bridge patches first; ours wraps it). No
   Angular interceptor, no wrapper around direct `CapacitorHttp.request()`. Never mutate a
   consumer `Request`/`Headers` (copy). Exclude the SDK's own transport.
5. **Allowlist = Android rules verbatim:** empty by default (inject nowhere), with a one-time
   debug warning when empty. Entries match exactly or as a dot-anchored suffix (`.example.com`).
   At least 2 labels per entry, no substring, no RegExp, ports ignored. Consumer docs state the
   `Access-Control-Allow-Headers: traceparent` requirement.
6. **Outcomes = Android's 6, same precedence, plus `skipped_no_cors`** (a `mode:'no-cors'` request
   cannot carry the header; it sits just after `skipped_off_allowlist`). A valid consumer-set
   header counts as `adopted`; a malformed one is overwritten. No `skipped_consumer_set`.
7. **Adopted:** `span.id` mirrors the foreign parent-id; `rum.action.id` stays the **local**
   root's `span.id` (Flutter/iOS reading).
8. **Sampling:** a session sampled out per ADR-019 captures nothing and sends no header. There is
   no `-00` injection; flags are always `01`.
9. **Ionic-only children** (if #79 keeps the capture): each Capacitor plugin call (the
   `nativePromise` wrap) and the router guard/resolver/lazy-chunk phases are child spans of the
   live root. Ionic page transitions are not children. `screen.duration` is annotation-only.
10. **Key tiers:**
    - Tier 1 (full span keys): the `interaction`/`navigation` root events, `http.request`, and the
      bridge/router children.
    - Tier 2 (`trace.id`, `rum.action.id`, `trace.root_type`): JS and native `app.crash`,
      hang/ANR, `custom_event`, `screen.duration`.
    - None: `metric` items, `page_load`, `app_lifecycle`, `session.*`, `user.profile.update`.
    - `http.request` stamps `span.start_time` at send (anchored to `performance.now()`); the start
      is not inferred as end minus duration.
11. **Native stitch = annotation only.** On root mint or replace, JS relays
    `{trace.id, rum.action.id, trace.root_type}` to the SDK plugin (the `setLastScreen` path: one
    bridge call per root, none per request or frame). Native keeps it as a non-parenting `lastRoot`
    and persists it with the crash record. A replayed native crash/hang/ANR carries the Tier-2 keys,
    plus `trace.root_expired=true` when the root was stale (iOS). Native mints no spans.
12. **Edges:** the root is cleared on background and on session rotation (later requests report
    `injected_expired`). Ids come from `crypto.getRandomValues`; all-zero ids are rejected.
    Redirect limitation documented: JS cannot re-check the allowlist per hop, so a 3xx to an
    off-allowlist host carries the header. Wire otherwise byte-identical to Android trace v3.

**Consequences:**
- (+) Zone, zoneless and plain JS behave the same; core takes no Angular dependency.
- (+) Allowlist and outcomes match the siblings; the only new outcome value is a free-string add.
- (+) Native crashes correlate to the action that preceded them at the cost of one bridge call
  per root.
- (−) Attribution is temporal: a background poll inside a tap's 2 s window is mis-attributed.
- (−) Direct `CapacitorHttp.request()` calls and third-party native HTTP get no header.
- (−) `skipped_no_cors` needs an entry in the backend outcome docs (#81).

---

## ADR-036 — Lightweight budget and modular architecture (#78)

**Date:** 2026-10

**Context:** `docs/research/lightweight-baseline.md` (#71): full stack ~21 KB gzip against
`.size-limit.json` budgets ~5× too loose; core does not tree-shake (`init()` wires every capture);
the top steady-state cost is the rAF frame loop that never idles, doubled on device by the native
frame sampler. #73: the frame loop and flush timer likely run inside NgZone. ADR-034 moves send to
native and left two questions here: gzip, and where session + sampling live.

**Decision:**

1. **Gzip, always, natively.** The native sender gzips every body (`Content-Encoding: gzip`;
   `java.util.zip` / zlib), matching Cordova T5. The collector already decompresses. Supersedes
   `CLAUDE.md` Rule 2 → "JSON only; gzip on the wire, applied by the native sender".
2. **Session + sampling are native** (Cordova A1/S1/S5): session id, 30-min timeout, rotation, the
   per-session secure-RNG roll (persisted with the session), sampling gate and caps at outbox
   append. JS reads `{sessionId, sampled}` via one async `getState` at init; native pushes on
   rotation. Until `getState` resolves JS buffers captures and injects **no** `traceparent`
   (keeps ADR-035 §8 true without blocking startup). Outcome value for those requests → #79.
3. **JS size budgets (gzip, size-limit, CI-fail):** core 14 KB, capacitor own 7 KB, angular own
   4 KB, full stack deduped 24 KB, **minimal** (`init` + errors + requests) 8 KB. Raising a
   ceiling needs an ADR line.
4. **Tree-shakeable imported captures.** `EdgeRum.init({ captures: [vitals(), frames(), …] })`.
   Always in core: errors, fetch/XHR requests + traces, session/native relay (the minimal build).
   Opt-in exports: `vitals`, `interactions`, `frames`, `memory`, `resourceTiming`, `longTasks`,
   `pageLoad`, plus Ionic-only captures (#79). `defaultCaptures()` = today's behaviour; used by
   `EdgeRumModule.forRoot()` when `captures` is omitted. `captureX` booleans removed. No lazy
   `import()` of captures (local `www`, no network saving).
5. **One frame source: rAF, idle-paused.** `FrameSampler.swift` / `FrameSampler.kt` deleted
   (native UI-thread timing misses WebView/JS jank). rAF pauses after 2 s with no input, scroll,
   route change or Ionic transition; resumes on the next. Runs outside NgZone. ADR-030 windowed
   shape kept, `frame.source=raf`; event name per #79. `frames()` is in `defaultCaptures()`.
6. **Memory + watchdogs.** JS `memory-web.ts` deleted. Native `MemorySampler` → opt-in `memory()`,
   not in defaults, 30 s interval. Low-memory / trim callbacks stay always-on. ANR / hang watchdogs
   default on; their switches move into the capture list. PLCrashReporter + NDK `.so` kept.
7. **Runtime ceilings (Playwright + CDP, 4× throttle, median of 5, every PR, absolute):**
   eval + `init()` ≤ 8 ms; `track()` ≤ 10 µs; SDK idle script ≤ 1 ms per 10 s static screen;
   JS heap after init + 2,000 events ≤ +2 MB. Native plugin load, IPA/APK delta and battery are
   measured per release on device and published in release notes — not gated.

**Consequences:**
- (+) Budgets actually guard "lightweight"; minimal build proves tree-shaking.
- (+) Idle Ionic screens stop waking JS every vsync; device runs one frame loop, not two.
- (+) ~5–10× less mobile data per batch.
- (−) Config break: `captureX` booleans → `captures` array; native frame data gone (iOS/Android
  `frame_render_time` from native no longer emitted).
- (−) CI bench adds a Playwright job to every PR; noise risk handled by median + headroom.
- Supersedes `CLAUDE.md` Rule 2, the Bundle rules section (`noExternal` OTel, 90/200 KB), and
  ADR-030's native frame samplers, at 5.0 implementation time.

---

## ADR-037 — Event catalogue for 5.0.0: Cordova names as baseline, gap fills, Ionic-only captures (#79)

**Date:** 2026-10

**Context:** `docs/research/ionic-gap-inventory.md` (#69) tags 13 Ionic captures as renames
against the processor's typed child tables and 13 as missing. `docs/research/ionic-platform-capabilities.md`
(#72) lists the cheap, Ionic-unique captures and two live bugs. ADR-034 (contract 4, native send),
ADR-035 (trace model) and ADR-036 (imported captures, rAF frames, opt-in memory) left the
catalogue itself open, along with two inputs: the outcome for requests sent before `getState`,
and the resource-timing volume/URL leak.

**Decision:**

1. **Baseline = Cordova's catalogue, name-for-name and key-for-key**, for every concept Ionic
   shares with it. Ionic only adds captures; it never renames a shared one. Concretely:
   `user.interaction` → `ui.interaction` (`ui.*`); M:`frame_render_time` → E:`frame.summary`
   (`frame.*`, `frame.source=raf`); `app.crash` `cause=ANR|Hang` → `app.anr` / `app.hang`;
   dotless memory keys → `memory.*`, pressure → E:`memory_pressure`; `metric.screen` →
   `screen.name`; `lifecycle.event` → `lifecycle.state`; battery keys camelCase → snake_case;
   `page_load` folded into `app.start.*` phases.
2. **Gap fills (on unless noted):**
   - `app.start`: built natively, Cordova phase model adapted to Capacitor (no `deviceready`).
     Carries the `launch` trace root. Part of core. Replaces `page_load` and `lifecycle.cold_start_ms`.
   - WebView death: `app.crash` `cause=WebViewTerminated`, `webview.{reason,detected_by}`.
     Android via `onRenderProcessGone`; iOS via JS reload heuristic (no swizzle). Always on.
   - `app.exit`: Android `ApplicationExitInfo`, harvested next launch. Always on.
   - `app.hang`: added on Android at 2 s; iOS threshold 5 s → 2 s. No JS-thread hang detector
     (long tasks cover it).
   - Rage / dead taps: `ui.rage` / `ui.dead` booleans on `ui.interaction`, Cordova rules, in
     `interactions()`.
   - `task.complete`: event reserved; API shape → #80.
   - `http.request`: templated `http.url` (digits or ≥32 chars → `{id}`, `vN` kept, depth ≤ 6),
     `http.{request_size,response_size}` where available, `success` = 200–399.
   - Skipped: view rollup, `screen.load`, `storage_usage`, `cpu_usage`, `sdk.health` event
     (counters stay on `session.finalized`).
3. **Ionic-only captures:**

   | Capture | Wire | Export | Default |
   |---|---|---|---|
   | Plugin-call timing (wrap `Capacitor.nativePromise`; SDK's own plugins excluded) | E:`bridge.summary` per screen window, `bridge.{plugin,method,count,p50_ms,p95_ms,error_count,error_codes}`. No per-call `bridge.call` | `bridge()` | on |
   | Router guards / resolvers / lazy chunk | `navigation.{guards_ms,resolvers_ms,chunk_load_ms}`; trace child spans per ADR-035 | angular `RouterCapture` | on |
   | Ionic page lifecycle | `screen.duration` fixed via capture-phase listener (bug fix) | angular | on |
   | Overlays / tabs / hardware back / keyboard | `ui.interaction`, `ui.type ∈ overlay_open\|overlay_dismiss\|tab_change\|back\|keyboard_show`, `ui.target` = component | `ionicUi()` | off |
   | WebView version, live-update bundle | context attrs `webview.version`, `app.bundle_id` (`WebView.getServerBasePath()`) | capacitor | always |
   | Angular route error | `app.crash` `cause=NavigationError`, unchanged | angular | on |

   Skipped: change-detection cost (private API), `nativeCallback` stream counts. Capgo rollback
   events → source-maps / live-updates fog.
4. **Requests before `getState` resolves** (ADR-036 §2): `traceparent.outcome =
   skipped_no_session` — an eighth value beside ADR-035's `skipped_no_cors`. The row still gets
   `trace.id`/`span.id` once the session lands.
5. **Resource timing:** `resourceTiming()` stays opt-in. Emits an aggregate `resource_timing`
   per screen window grouped by templated host: `resource.{initiator_type,count,p95_ms,transfer_kb}`.
   No per-resource URLs; CapacitorHttp proxy URLs (`/_capacitor_http_interceptor_`) and the SDK
   endpoint are excluded.

**Consequences:**
- (+) Ionic rows land in the processor's typed child tables (`ui.interaction`, `app.anr`/`app.hang`,
  `frame.summary`) instead of the generic bag; Ionic and Cordova are interchangeable for analytics.
- (+) Two live 4.x bugs (`screen.duration` blind, `HttpClient` XHR uncaptured) are closed by design.
- (+) Resource-timing leak and volume amplifier removed.
- (−) Breaking wire change for every renamed event; dashboards on 4.x names need the backend
  mapping (#81).
- (−) `skipped_no_session` and `bridge.summary` / `navigation.*_ms` / `webview.version` /
  `app.bundle_id` need backend columns or docs (#81).
- `docs/payload-schema.json` and the `CLAUDE.md` eventName table are rewritten at 5.0
  implementation time, not now.

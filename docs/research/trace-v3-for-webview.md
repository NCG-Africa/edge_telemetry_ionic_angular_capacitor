# Trace v3 for a WebView SDK: the frozen wire, the siblings, the backend, the carrier options

Ticket #70 (wayfinder map #68). Research only. As of 2026-10-27.

Pins (HEAD read): Ionic `570bb58` · Android `330cb1d` · iOS `b8cc022` · Flutter `d17fc58` · RN `f5a78a8` · Cordova `db8ad4d` · collector `9c9b385` · processor `488c29a` · analytics `8632809` · wayfinder (not a git repo; read as-is) · Capacitor native bridge `capacitor-swift-pm` 8.3.4 (Ion:packages/capacitor/Package.resolved:9).

## Summary

- **The wire is frozen by Android, and iOS adopts it verbatim** (IS:13-19). Spans are attributes on events that already exist. No span events. W3C `traceparent` only, with no `tracestate` or baggage.
- **Contract 4 says nothing about trace.** `grep -ci trace W:spec.md` returns 0. Trace keys are ordinary event attributes, so R1 (identity in envelope, event attributes kept) and R11 (minor = additive) leave them alone.
- **Every JS sibling (RN, Cordova) uses an ambient root with no async-context carrier.** "Single-threaded JS, read synchronously inside the patch" is the stated rationale (R:adapters/traceManager.ts:9-13). No sibling uses Zone.js. Flutter does not use Dart `Zone` either; it uses an ambient root that it freezes at the call (F:capture/trace_injection.dart:228-245).
- **The backend already stores the columns.** The processor writes 7 trace columns on every row, with no validation beyond truncation (P:telemetry/extract.go:279-289). `traceparent.outcome` stays in the JSONB bag only.
  - Analytics shows mobile traces with no `sdk.*` filter. Ionic rows appear once `trace_id` is lowercase 32-hex and the session/app join resolves (An:repo/trace.go:75).
- **Ionic today has no trace code.** It patches `fetch` only and not XHR (Ion:packages/core/src/instrumentation/requests.ts:44-97). Its banned-word tests forbid camelCase `traceId`/`spanId`, which never collide with dotted `trace.id`. The **docs** tests ban `span`/`tracing` in consumer docs (Ion:test/docs-terminology.test.ts:19-28), and they would collide.
- **The hardest WebView-specific fact is CORS.** The WebView origin is `capacitor://localhost` or `https://localhost`, so every API call is cross-origin. Adding `traceparent` forces a preflight and breaks the request if the server does not allow the header.
  - With `CapacitorHttp` enabled, the same request goes native and skips CORS. The same allowlist entry is safe on one path and breaking on the other.

## Citation legend

| Prefix | Path under `/Users/mktowett/Development/edge_rum/` |
|---|---|
| `AS:` | `edge_telemetry_android/docs/specs/` (`dts` = `distributed-trace-span.md`, `bwc` = `backend-wire-contract.md`) |
| `A:` | `edge_telemetry_android/telemetry_library/src/main/java/com/androidtel/telemetry_library/` |
| `IS:` | `edge_telemetry_ios_sdk/docs/specs/distributed-trace-v3-ios.md` |
| `F:` | `edge_telemetry_flutter/lib/src/` |
| `R:` | `edge_telemetry_react_native/src/` |
| `C:` | `edge_telemetry_cordova_sdk/` |
| `Col:` | `edge_telemetry_collector_go/` |
| `P:` | `edge_telemetry_processor_go/internal/` |
| `An:` | `EdgeTelemetryRUMAnalyticsGo/internal/` |
| `Ion:` | `edge_telemetry_ionic_angular_capacitor/` |
| `W:` | `wayfinder/` |
| `Cap:` | Capacitor iOS `native-bridge.js` 8.3.4. The copy read is the SPM build artifact at `Ion:packages/capacitor/.build/index-build/artifacts/capacitor-swift-pm/Capacitor/Capacitor.xcframework/ios-arm64/Capacitor.framework/native-bridge.js` |

## 1. Frozen trace v3 wire

### 1.1 Attributes (owner: Android; iOS "wire-identical, mechanism free", IS:11-16)

| Key | Type | On | Cite |
|---|---|---|---|
| `trace.id` | 32 lowercase hex | every span-carrying event, plus `app.crash`/`app.hang` | AS:dts:925; AS:bwc:308 |
| `span.id` | 16 lowercase hex | every span-carrying event. When adopted, it mirrors the foreign parent-id | AS:dts:926 |
| `parent.span.id` | 16 hex | children only. Omitted on roots, adopted, unattributed, unwired and expired | AS:dts:927 |
| `rum.action.id` | 16 hex = the root's `span.id` | action and child events, crash, hang | AS:dts:928; AS:bwc:314 |
| `trace.root_type` | string, VARCHAR(16) | every span-carrying event plus crash/hang, denormalized | AS:dts:930; AS:bwc:602-608 |
| `span.start_time` | ISO-8601 ms UTC **string** | every span-carrying event | AS:bwc:589-598 |
| `span.duration_ms` | number (ms) | **children only**; roots derive it server-side | AS:bwc:594,600 |
| `traceparent.outcome` | string enum | `http.request` only. **Absent = not traced** | AS:dts:929 |
| `ui.name_source` | enum | `ui.interaction` | AS:dts:933 |

- **Root types (Android):** `launch`, `interaction`, `navigation`, `request` (AS:dts:43; A:core/trace/TraceManager.kt:100).
  - iOS adds `resume` (IS:33).
  - RN adds `custom` (R:adapters/traceManager.ts:32).
- **Outcome enum (6, with precedence)** (AS:bwc:572-587): `skipped_off_allowlist` > `adopted` > `injected_attributed` > `injected_unwired` > `injected_expired` > `injected_unattributed`.
  - Store it as VARCHAR, not an enum, so a 7th value needs no migration (AS:bwc:587).
  - The ladder is at AS:dts:808-827.
- **`traceparent`:** `00-<trace.id>-<span.id>-<flags>`, version `00`, flags `01` (AS:dts:48-50; A:…/TraceManager.kt:410).
  - The invariant: the recorded `span.id` equals the header's parent-id. Off-allowlist still stamps ids locally with no header, which makes "header stripped in transit" computable (AS:dts:937-939).
- **W3C rules** (Trace Context Level 1, W3C Rec 2021-11-23):
  - Lowercase hex.
  - All-zero trace-id or parent-id is invalid.
  - Version `ff` is invalid.
  - The sampled flag is the low bit, read by bitmask.
  - Header names are sent lowercase and accepted in any case.
  - No PII in either header.
  - §7.3: cross-origin requests may fail if `Access-Control-Allow-Headers` excludes the header.
- **Root lifetime:** 2 s idle and a 10 s cap. The idle clock extends on child start and on request completion. Expiry is evaluated lazily (AS:dts:37; A:…/TraceManager.kt:44-46,109-110). The launch root is exempt from idle until the first resume (AS:dts:38).
- **Inbound adoption:** mirror the ids and leave the header untouched (A:…/TraceManager.kt:294-305).
  - A malformed inbound header is overwritten (A:…/TraceManager.kt:445-458).
- **Terminal events** get an annotation only (`trace.id`, `rum.action.id`, `trace.root_type`) from a non-expiring `lastRoot` that never parents (AS:dts:419-440; A:…/TraceManager.kt:356-361). `app.exit` is excluded (AS:bwc:726).
- **Prohibitions and out-of-scope:**
  - No OTLP span objects.
  - No root-close event.
  - No reopening of "empty allowlist = inject nowhere".
  - No sampling design: sampling is fixed at 1.0.
  - No `tracestate`.
  - (AS:dts:1086-1112; AS:bwc:725.)
- **iOS-only prohibitions:**
  - `span.start_time` is never a number, because the processor NULLs it silently (IS:1102-1113).
  - `lastRoot` never reaches a request (IS:15.3).
  - Do not mint a root per unattributed request (IS:15.4).
- **Allowlist:** empty by default, with a one-time warning when empty. Entries are exact or dot-anchored suffix (`.example.com`). Each entry needs at least 2 labels. Substring match is never allowed (AS:dts:289-330; A:…/TraceManager.kt:433-437; A:core/TelemetryManager.kt:318-328).

### 1.2 Per-sibling implementation

| | Root model | Carrier / propagation | HTTP clients that get `traceparent` | Allowlist | Divergences from the frozen wire |
|---|---|---|---|---|---|
| **Android** (shipped) | Ambient root, 2 s/10 s. Launch, tap (`onSingleTapUp`), navigation, request-reroot (A:…/TraceManager.kt:192-283) | `ThreadLocal` plus an OkHttp request tag stamped at `newCall()` on the caller thread (AS:dts:36) | OkHttp only, via `instrument(client)`. Ktor, Volley, `HttpURLConnection` and gRPC are out of scope (AS:dts:1102-1104) | Exact plus `.suffix` | Owner |
| **iOS** (spec **frozen, not built**: "Zero trace code exists today", IS:39) | Ambient root with `os_unfair_lock`, 2 s/10 s, plus `resume` (IS:51-60, 466-485) | Swizzled `URLSession` task creation; a "bag" on the request (IS:518-602, 742) | `URLSession` family | Android's, verbatim (IS:621-644) | `resume` root type. Flags `00` when unsampled; inject anyway (IS:487-516). `trace.root_expired=true` on stale crash annotation (IS:962-986). Strips the header on a cross-host redirect (IS:719-740) |
| **Flutter** | Ambient root, 2 s/10 s (F:managers/trace_manager.dart:105-106). Roots: launch, interaction, request, navigation (:19-30) | Context frozen at call time (`TraceFreeze`). No Dart `Zone` | `dart:io` via `HttpOverrides.global` (F:capture/http_overrides.dart:26), plus a `package:http` wrapper (F:capture/http_client_capture.dart:37) | Exact plus `.suffix`, at least 2 labels (F:capture/trace_injection.dart:102-117) | 5 outcomes, with no `injected_unwired`, which is unreachable (:18-38). Session rotation counts as `injected_expired`. Flags are always `01` (:61-70) |
| **RN** (JS, closest model) | Ambient root on a `Telemetry`-owned instance, 2 s/10 s (R:adapters/traceManager.ts:40-41,88-111). Launch at construction, `interaction` always replaces the live root, `navigation`/`request` mint when no root is live, plus `custom` (:136-165) | **Plain synchronous field read inside the patch**. No tag, no thread-local, no `lastRoot`; crash handlers read the carrier (:9-13) | `fetch` (web: R:adapters/web/interceptFetchWeb.web.ts:73-87) and XHR (R:adapters/xhrIntercept.ts:84-116). The consumer header is captured at `setRequestHeader` write time | **Exact only**, bare hosts, ports ignored, **no suffix** (R:adapters/traceHeader.ts:50-85). Throws in dev, drops in prod | Extra outcomes `skipped_no_cors` and `skipped_consumer_set`; no `injected_unwired` (:16-24). An unsampled session gets **no header** (traceManager.ts:224). On adopt, `rum.action.id` is the foreign span (traceManager.ts:183-191), where Flutter/iOS keep the local one. Never repairs a malformed consumer header (traceHeader.ts:87-93). Tier-2 annotation on `app.crash`/`app.error`/`custom_event` (R:core/telemetry.ts:192,1363) |
| **Cordova** (JS, WebView, same shape as Ionic) | **No root.** Random ids per request (C:src/network.ts:41-47) | none | `fetch` plus XHR (C:src/network.ts:72-127). Skips `no-cors` (:80). A consumer header wins (:86,118) | `correlateRequestsTo: (string\|RegExp)[]`, exact string or RegExp, default none (C:src/core.ts:45-46) | Only `trace.id`/`span.id` on `http.request`. No `rum.action.id`, root type, outcome or `span.start_time` (C:docs/spec.md:97) |

## 2. Backend today

- **Collector: pass-through.**
  - It never inspects event attributes. Only the envelope is closed: unknown root keys are stripped on v4 batches (Col:internal/telemetry/handler.go:138-142; envelope.go:69-79).
  - Every string is capped at 10,000 runes (Col:internal/telemetry/validator.go:30,101). There is no trace logic: grep for `trace`/`traceparent` in `.go` finds nothing.
  - Collector CORS allows only `X-API-Key` and `Content-Type`, which affects the SDK's own POSTs on web only (Col:cmd/server/routes.go:19-23).
- **Processor:**
  - `extractTraceInfo` (P:telemetry/extract.go:279-289) reads `trace.id`(32), `span.id`(16), `parent.span.id`(16), `rum.action.id`(16), `trace.root_type`(16), `span.start_time` and `span.duration_ms`. It runs for **every** event, metric items included (P:telemetry/service.go:662).
  - Columns live on `rum_telemetry_events` (P:db/migrations/0002_android_wire_contract.up.sql:5-12), with a partial index on `trace_id` (0006) and the view `rum_action_envelopes` (0002:96-106).
  - `http.request` also writes `trace_id`/`span_id`/`parent_span_id` into `rum_http_requests` (P:telemetry/extract.go:291-301; P:db/repository.go:349-363). `rum_action_id` and `traceparent_outcome` were **deliberately removed** from that table (P:db/schema_check_test.go:14).
  - **`traceparent.outcome` lands only in the `attributes` JSONB bag.**
- **No validation or drop rules, only silent degradation:**
  - Over-length strings are truncated by rune (P:telemetry/extract.go:405-417).
  - Hex is not checked.
  - A non-string `span.start_time` becomes NULL with no error or log (P:telemetry/extract.go:119-135; IS:1102-1113).
- **Analytics:**
  - Mobile trace list and detail come from `rum_http_requests` UNION `rum_telemetry_events`, joined to `rum_sessions` and `rum_apps`, then LEFT JOINed to backend `traces.spans` by `trace_id` in UUID form (An:repo/trace.go:41-104,222-248,362-367).
  - Filters: `rum_action_id` (An:repo/trace.go:101-102). Endpoints are at An:api/traces.go:41-49.
  - **Not consumed:** `traceparent.outcome`, `trace.root_type`, `span.start_time` and `rum_action_envelopes`. A grep in `An:` finds no reader.
  - The HTTP span start is computed as `request_timestamp - duration` (An:repo/trace.go:53). Event rows use the event `timestamp`.
  - The "web" traces (`/web/apps/...`) are a **different product**: a browser snippet writing into `rum.network_requests` (An:repo/trace_web.go:11-14,48), app platform `browser` (:334). **Ionic would not appear there.** It goes through the mobile path.
- **What an Ionic 5.0 row needs to show up:**
  1. `trace.id` must be lowercase 32-hex. Event rows are filtered by `~ '^[0-9a-f]{32}$'` (An:repo/trace.go:75).
  2. A session and app that resolve through the processor. Contract-4 identity: `app.platform` must be ios or android (R16).
  3. `http.request` must be the event name, so the row reaches `rum_http_requests`. Ionic already uses it.
  4. No `sdk.*` filter exists in the trace repo (grep `sdk` in An:repo/trace.go finds none).
  5. To link to backend spans, the app's API servers must accept the header and record it in `traces.spans` (outside this repo).

## 3. Ionic today (5.0 change surface)

| Surface | State | Cite |
|---|---|---|
| HTTP capture | **`fetch` monkey-patch only**, no XHR. Records `http.request` after the response, so the timestamp is the end. No header write. `Date.now()` timing | Ion:packages/core/src/instrumentation/requests.ts:44-97 |
| Registration | Native-gated block in `init`. Self-exclusion via `ignoreUrls` | Ion:packages/core/src/EdgeRum.ts:226-230 |
| SDK's own transport | On native, `CapacitorHttp.request` (a plugin call, which never touches `window.fetch`). On web, fetch. Background flush uses XHR/`sendBeacon` | Ion:packages/capacitor/src/bootstrap.ts:79-82; capacitor-http-fetch.ts:74; LifecycleCapture.ts:146 |
| Interactions | `document` click listener, **capture phase**, passive. A 50 ms dedup drops a repeat. Emits `user.interaction` (the processor routes `ui.interaction`) | Ion:packages/core/src/instrumentation/interactions.ts:14,61-87 |
| Router | `Router.events` subscription. `NavigationStart` records a pending entry; `NavigationEnd/Cancel/Error` emit | Ion:packages/angular/src/RouterCapture.ts:79,90-110 |
| Native relay precedent | `setLastScreen` JS→native, throttled at 1000 ms. A template for relaying the last root to native crash/hang/ANR | Ion:packages/capacitor/src/NativeCrashCapture.ts:65,81,123; ios/Plugin/EdgeRumCrashPlugin.swift:86; android/…/EdgeRumCrashPlugin.kt:75 |
| Native HTTP capture | none (no URLProtocol or OkHttp in the plugin) | grep of Ion:packages/capacitor/{ios,android} |
| Identity | `sdk.platform: 'ionic-angular-capacitor'`, `sdk.contract_version '3.1.0'` | Ion:packages/core/src/index.ts:2-3; internal/context.ts:80 |
| Peer range | `@angular/* >=16`, built against 18 with `zone.js ~0.14` | Ion:packages/angular/package.json:25-40 |

**Banned-word tests that 5.0 must redraw:**

- **Payload tests ban camelCase `traceId`/`spanId`/`resourceSpans`.**
  - Sites: Ion:test/envelope-shape.test.ts:68-75, plus ≈11 package tests, e.g. Ion:packages/core/test/requests.test.ts:202-203, pipeline.test.ts:110-111, angular/test/router-capture.test.ts:323-324, capacitor/test/device-context.test.ts:331-332.
  - Dotted `trace.id`/`span.id` pass these, including the `/traceId/i` variants, because of the dot. **No change is forced, but the intent ("no OTel names") needs restating**, because the wire will now say `span`.
- **Consumer-docs test bans `span`, `tracer`, `tracing`** in quick-start, config-reference, backend-integration, privacy and CHANGELOG (Ion:test/docs-terminology.test.ts:11-28,46-49).
  - A raw-content check, not prose-only, so it fires even inside code fences. Any doc that names `span.id`, or a CHANGELOG entry about spans, fails.
  - `trace.id` and `traceparent` would pass the test, because the ban is `tracer`/`tracing`, not `trace`.
- **`.d.ts` check** regex: `TracerProvider|SpanProcessor|MeterProvider|LoggerProvider|SpanExporter|opentelemetry|otlp` (Ion:scripts/terminology-check.mjs:6). It does not ban `trace`/`span`.
  - **CLAUDE.md Rule 1 does ban "span / trace"** in the public surface and in errors and console output (Ion:CLAUDE.md:23-49; docs/terminology.md:15).
  - A config key such as `traceHostAllowlist` (the RN, Android and Flutter name) breaks Rule 1. Cordova's `correlateRequestsTo` does not.

## 4. JS/WebView carrier options

The WebView JS is single-threaded, and every capture site (click listener, router subscription, fetch/XHR patch) runs synchronously in the caller's turn. That is the RN argument (R:adapters/traceManager.ts:9-13) and it applies here unchanged. The question is only what an async gap does to attribution.

**(a) Ambient root + expiry (RN/Android/Flutter/iOS model)**
- **How it works:** a single mutable `root` holds `{traceId, spanId, rootType, startedAt, lastTouch}`.
  - Read synchronously at `fetch()`/`xhr.send()`.
  - Lazy 2 s/10 s expiry.
  - Mint on click (capture phase, which runs **before** the app's handler, so the request it causes parents correctly; the Android 300 ms-late defect AS:dts:681 does not apply), on `NavigationStart` when no root is live, and on a request when no root is live.
  - Cleared on background and on session rotation (R:adapters/traceManager.ts:255-262).
- **Ionic fit:** high. Works identically with Zone, zoneless and plain JS, and needs no Angular dependency in core.
- **Cost:** about 1 object plus a few `Date.now()` calls per request, and 24 random bytes per span. RN's whole manager is 363 lines including comments; the wire adds roughly 250–350 B per span-carrying event (estimate).
- **Failure modes:**
  - **Temporal, not causal.** A background poll inside a tap's 2 s window is mis-attributed.
  - Concurrent actions (a tap during a slow chain) re-parent to the newest root.
  - Chains longer than 10 s fall to `injected_expired`, which is visible by design.

**(b) Zone.js (Angular zone properties)**
- **How it works:**
  - `Zone.current.fork({name, properties:{edgeRoot}})`, then `zone.run(handler)`.
  - Read with `Zone.current.get('edgeRoot')` in the fetch patch (zone.js 0.14.10 `lib/zone-impl.d.ts:153,169,373`).
  - Zone propagates through `setTimeout`, promises, XHR and event callbacks that zone.js patches.
- **Ionic fit:** low to medium.
  - The SDK's document click listener cannot make the **app's** handler run inside its fork. Angular registers that handler in its own zone. Capturing it would need an `onInvokeTask` ZoneSpec interception or an `EventTarget` patch.
  - Core would need a soft Zone dependency, which CLAUDE.md forbids importing from Angular in core. Zone is a global, so a guarded global read is possible.
- **Cost:** a fork per action plus a property lookup per request. Zone.js's own overhead is already paid by zone apps.
- **Failure modes:**
  - **Absent in zoneless apps**, so the code needs fallback (a) anyway.
  - Native `async/await` continuations are not tracked by zone.js (unverified here; Angular CLI downlevels for zone apps).
  - `runOutsideAngular` and third-party callbacks lose the context.
  - zone.js is in maintenance: "no longer accepting new features… strongly discourages using Zone.js outside of Angular application contexts" (zone.js 0.14.10 README:14-18).

**(c) Zoneless Angular**
- **Version facts (angular.dev):**
  - Experimental in v18 (`provideExperimentalZonelessChangeDetection`).
  - **Stable as of v20.2** (`provideZonelessChangeDetection`).
  - **Default in v21+**. The `ng new` `zoneless` option defaults to `true`. (angular.dev/roadmap; /guide/zoneless; /api/core/provideZonelessChangeDetection; /cli/generate/application.)
- **Consequence:** new Ionic Angular apps on v21+ have **no `Zone` global**. Option (b) works only for v16–v20 and opted-in zone apps. The SDK's peer range spans both worlds (Ion:packages/angular/package.json:25-27).

**(d) TC39 `AsyncContext`**
- `AsyncContext.Variable` (`run`/`get`) and `AsyncContext.Snapshot` (`wrap`/`run`) are the right primitive.
- **Stage 2**, per the proposal README (github.com/tc39/proposal-async-context, read 2026-10-27).
- The README names no shipping engine or polyfill. WKWebView/Android System WebView support is **unverified**, presumed none.
- Usable only as a future feature-detected upgrade of (a).

**(e) Explicit API passing**
- **How it works:** a public `EdgeRum.<x>(name, fn)` wrapper or a returned handle that the app passes to its request code. RN's `manualSpan` / `task.complete` (R:adapters/traceManager.ts:155-165) is a leaf-only precedent.
- **Ionic fit:** fine as an *override*, poor as the primary path, because nobody wires it.
- **Cost:** zero on the hot path.
- **Failure modes:** coverage depends on the app. The naming must pass Rule 1 (no `span`/`trace` in the API).

**Options matrix**

| | Zone apps | Zoneless (v21 default) | Async continuity | Mis-attribution risk | Core dep | Cost |
|---|---|---|---|---|---|---|
| (a) ambient+expiry | ✓ | ✓ | temporal only | medium (2 s window) | none | lowest |
| (b) Zone.js | ✓ (partial: app handler not inside the fork) | ✗ | causal via patched APIs; native await unverified | low where it works | soft global | low |
| (c) zoneless | — | n/a | none | — | — | — |
| (d) AsyncContext | future | future | causal | lowest | none | n/a today |
| (e) explicit | ✓ | ✓ | caller-defined | none (where wired) | none | none |

## 5. Injection surfaces

- **`fetch`:**
  - Ionic already patches it (Ion:…/requests.ts:97). Adding a header means copying `init.headers`. Never mutate a consumer `Request`/`Headers` (R:adapters/traceHeader.ts:125-135; C:src/network.ts:84).
  - `init.headers` replaces a `Request`'s headers (R:…/interceptFetchWeb.web.ts:69-72).
  - `mode:'no-cors'` restricts requests to CORS-safelisted headers (WHATWG Fetch §CORS-safelisted request-header), so skip it. RN has the outcome `skipped_no_cors`; Cordova skips silently.
- **XHR:** missing in Ionic (gap C6, Ion:docs/research/ionic-gap-inventory.md). This needs:
  - an `open` patch for the URL;
  - a `setRequestHeader` patch for the consumer-header presence flag;
  - an inject at `send` (R:adapters/xhrIntercept.ts:84-116; C:src/network.ts:110-127).
  - It must exclude the SDK's own background-flush XHR (Ion:packages/capacitor/src/LifecycleCapture.ts:146).
- **Angular `HttpClient`:**
  - Backend default: **XHR in v20** ("By default, HttpClient uses the XMLHttpRequest API", v20.angular.dev/guide/http/setup). Current angular.dev says **`FetchBackend` is the default and `withFetch` is deprecated**, with `withXhr()` to opt back. The exact version of the flip is unverified (likely v21/v22).
  - So **today Ionic misses HttpClient traffic on any XHR-backend app.** Patching both fetch and XHR covers either backend with no Angular dependency.
  - An `HttpInterceptorFn` (`req.clone({headers: req.headers.set(...)})`, angular.dev/api/common/http/HttpInterceptorFn) is an alternative that lives in `packages/angular`. Drawbacks:
    - It needs consumer wiring via `withInterceptors`.
    - It misses non-HttpClient calls.
    - It double-injects if a patch also runs, so it needs the presence check.
  - Whether `FetchBackend` binds `globalThis.fetch` at construction or per call matters if the SDK patches after HttpClient instantiates. **Unverified.**
- **`CapacitorHttp`:**
  - Off by default (capacitorjs.com/docs/apis/http, Configuration).
  - When enabled, the **native bridge replaces `window.fetch` and the `XMLHttpRequest.prototype` methods at bridge init**, before app JS runs (Cap:441-475,594-681). The SDK's later patch therefore wraps it and **does see these requests**.
  - The header the SDK adds goes through `new Request(resource, options)`, then `request.headers`, then `nativeHeaders`, then `nativePromise('CapacitorHttp','request',{headers})` (Cap:485,521-537). XHR has the same path (Cap:677-681).
  - That request runs on the native stack (URLSession/HttpURLConnection), so **no CORS and no preflight**.
  - GET/HEAD/OPTIONS go through a same-origin proxy URL `/_capacitor_http_interceptor_?u=…` via the original WebView fetch (Cap:141-154,488-515). That the native scheme handler forwards custom headers like `traceparent` to the origin is **unverified**.
  - Direct `CapacitorHttp.request()` calls by the app bypass every JS patch. That is the same path the SDK's own transport uses (Ion:packages/capacitor/src/bootstrap.ts:81). Capturing them would need wrapping the plugin proxy.
- **Native plugin calls / bridge:**
  - Capacitor plugin calls carry JSON options, so a `traceparent` or `{trace.id, rum.action.id, trace.root_type}` can be passed to the SDK's own plugin. The precedent is `setLastScreen` (Ion:packages/capacitor/src/NativeCrashCapture.ts:65,123).
  - Best use: an annotation-only `lastRoot` for native `app.crash` (NativeCrash/Hang/ANR) replayed on next launch. The AS Δ11 analogue; Android excludes `app.exit` cross-process (AS:bwc:726), while iOS persists the ids for crash replay (IS:937-960).
  - Third-party plugins that do native HTTP (downloads, uploads) get nothing unless they accept headers.
  - Ionic's native layer has no HTTP capture, so there is no native injection seam today.
- **CORS:**
  - The WebView origin is `capacitor://localhost` on iOS (`iosScheme` default `capacitor`) and `https://localhost` on Android (`androidScheme` default `https`, `hostname` default `localhost`) (capacitorjs.com/docs/config). Every API call is therefore cross-origin.
  - `traceparent` is not CORS-safelisted (WHATWG Fetch), so it **turns a simple request into a preflighted one**: an extra round trip per new origin+headers combination, subject to `Access-Control-Max-Age`.
  - It **fails the request** if the server's `Access-Control-Allow-Headers` omits `traceparent` (W3C TC §7.3).
  - So for a WebView the allowlist is a **correctness** gate, not just a privacy gate. This is RN's "dark on upgrade so nobody's CORS breaks" rationale (R:adapters/traceHeader.ts:50-53).
  - With CapacitorHttp enabled, the same host has no CORS exposure.
  - **Redirects:** JS cannot re-run the allowlist per hop (only opaque `redirect:'manual'`), so iOS's §8.6 fix (IS:719-740) has no WebView equivalent. A 3xx to an off-allowlist host carries the header (unverified per-engine).

## 6. Open questions for the grilling tickets

**Terminology firewall**
- Does the dotted wire vocabulary (`span.id`, `trace.id`, `traceparent.outcome`) breach Rule 1, or is the wire exempt as a backend contract? The wire already says `telemetry_batch`.
- Is the config key named `traceHostAllowlist` (sibling parity) or a firewall-safe name like Cordova's `correlateRequestsTo`? The warning and error strings need the same decision.
- Consumer docs must explain the CORS requirement for `traceparent` without the words `span` or `tracing`. Does `docs-terminology.test.ts` move to prose-only, or do the banned terms change?
- Do the camelCase `traceId`/`spanId` payload assertions stay as the "no OTel" guard, and does a new test pin the dotted keys?

**Contract-4 fit**
- Contract 4 is silent on trace. Do trace keys ride 5.0 as additive event attributes under R1/R11? Or does the wayfinder spec need an R17 that pins the trace vocabulary family-wide (outcome enum, root types)?
- Which outcome dialect does Ionic speak? Android 6, Flutter 5, RN 7 (`skipped_no_cors`, `skipped_consumer_set`), Cordova none. Does the backend accept RN's extras? The processor stores it as a JSONB-only string, so nothing breaks.
- Sampled-out sessions: RN sends no header (R:adapters/traceManager.ts:224); iOS sends `-00` (IS:487-516). Ionic's `sampleRate` exists, so pick one.
- On `adopted`, is `rum.action.id` local (Flutter, iOS) or foreign (RN)?
- With R16 (OS ∉ android/ios disables the SDK), is web-mode injection in scope at all? It affects `ionic serve` development only.
- Does the backend want `trace.root_type = resume` (iOS) on Ionic foreground?

**Trace model**
- Carrier: (a) alone, (a) with an opportunistic Zone upgrade, or (a) plus an explicit override (e)? Zoneless is the v21 default, so (b) cannot be the base.
- Root set: launch (at `init` or `performance.timeOrigin`? RN uses `timeOrigin` on web, R:adapters/traceManager.ts:95-101), interaction (click capture), navigation (`NavigationStart` vs `NavigationEnd`), request.
  - Does an Ionic `ionViewWillEnter` count?
  - Does a click deduped by the 50 ms window still mint a root?
- Which events carry the Tier-1 versus Tier-2 keys? Candidates: `screen.duration`, `page_load`, `app_lifecycle`, `custom_event`, the `metric` items.
- Event-name renames (`user.interaction` → `ui.interaction`) are needed for `ui.name_source` and the processor child table. Does this ship in the same major?
- Capture surface: add XHR? Wrap `CapacitorHttp.request()` for direct plugin users? Use an Angular interceptor or global patches only?
- Native annotation: relay the live root to native through the bridge (like `setLastScreen`) so replayed native crashes, hangs and ANRs carry `trace.id`/`rum.action.id`? What throttle, and `trace.root_expired` à la iOS?
- Allowlist semantics: exact plus dot-suffix (Android, iOS, Flutter) or exact-only (RN)? Is RegExp allowed (Cordova)? Do we warn once when the list is empty?
- Should `http.request` timing move to `performance.now()` plus an explicit `span.start_time` at send? Today the row timestamp is the response end (Ion:…/requests.ts:60-88), and analytics infers start as end minus duration (An:repo/trace.go:53).

## Unverified

- AsyncContext engine or polyfill availability in WKWebView and Android WebView.
- The Angular version in which `FetchBackend` became the `HttpClient` default.
- Whether `FetchBackend` binds `fetch` eagerly.
- Whether zone.js tracks native `async`/`await`.
- Whether the Capacitor GET/HEAD proxy (`/_capacitor_http_interceptor_`) forwards custom request headers natively.
- Engine behaviour for a custom header on a cross-origin redirect.
- Byte cost per event (an estimate, not measured).

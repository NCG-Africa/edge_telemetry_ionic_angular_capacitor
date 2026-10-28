---
title: edge-rum 5.0.0 (Ionic Angular Capacitor) — build spec
status: approved 2026-10-28
source: map "edge-rum 5.0 — traces & spans, contract 4 parity, Ionic specialisation" (NCG-Africa/edge_telemetry_ionic_angular_capacitor#68)
---

# edge-rum 5.0.0 — build spec

Packages `@nathanclaire/rum`, `@nathanclaire/rum-capacitor`, `@nathanclaire/rum-angular` 5.0.0, wire contract 4.0.0. Each rule is stated **once**, numbered, and links the ADR that decided it. ADRs (`docs/decisions.md`) hold the reasoning; this doc holds the rules. Impl issues cite rules by number ("spec X5").

**Baselines, cited not restated:**
- Contract 4 rules **R1–R16**: `edge_rum/wayfinder/spec.md` (`ionic` already in R2).
- Cordova build spec `edge_telemetry_cordova_sdk/docs/spec.md` (rules `Cordova A1`, `Cordova T5`, …). Where this spec says "= Cordova Xn", port that rule verbatim, substituting the Ionic swaps listed beside it.
- Research: [gap inventory](research/ionic-gap-inventory.md) · [trace v3 for WebView](research/trace-v3-for-webview.md) · [lightweight baseline](research/lightweight-baseline.md) · [platform capabilities](research/ionic-platform-capabilities.md) · [competitors](research/ionic-competitor-sdks.md) · [backend readiness](research/backend-readiness.md).

Rule prefixes: **K** packaging · **A** architecture/bridge · **W** wire fit · **X** traces · **L** lightweight budgets · **E** event catalogue · **N** naming/keys · **C** config/API · **T** transport · **S** sampling/caps · **P** privacy/consent · **Y** symbols · **G** backend · **M** migration · **Q** tests · **V** release.

ADR links: [033 terminology](decisions.md#adr-033--terminology-firewall-narrowed-to-opentelemetry-identity-tracespan-allowed-75) · [034 contract 4 fit](decisions.md#adr-034--contract-4-fit-native-core-owns-identity-outbox-and-send-web-is-a-no-op-76) · [035 traces](decisions.md#adr-035--trace-model-ambient-root-fetchxhr-injection-native-crash-annotation-77) · [036 lightweight](decisions.md#adr-036--lightweight-budget-and-modular-architecture-78) · [037 catalogue](decisions.md#adr-037--event-catalogue-for-500-cordova-names-as-baseline-gap-fills-ionic-only-captures-79) · [038 backend](decisions.md#adr-038--backend-changes-to-surface-ionic-50-events-and-traces-81) · [039 privacy](decisions.md#adr-039--privacy-hooks-and-sampling-for-500-95) · [040 API](decisions.md#adr-040--public-api-and-configuration-for-500-80) · [041 migration](decisions.md#adr-041--4x--50-migration-path-100) · [042 symbols](decisions.md#adr-042--release-identity-and-symbol-upload-for-50-101) · [043 tests/rollout](decisions.md#adr-043--test-strategy-and-coordinated-rollout-for-50-102)

---

## 1. Overview

```
 WebView (JS: core + -capacitor + -angular)              Native plugin "EdgeRum" (Android Kotlin / iOS Swift)
 ┌────────────────────────────────────────┐  plugin call  ┌──────────────────────────────────────────┐
 │ capture: errors, fetch/XHR + traceparent│  enqueue()   │ capacitor.config prefs · identity · session│
 │ router + phases, Ionic lifecycle, taps, │ ───────────▶ │ sampling + caps gate (at append)          │
 │ vitals, rAF frames, bridge.summary      │              │ outbox ── seal ── gzip ── POST            │
 │ ambient trace root · beforeSend · buffer│ ◀─────────── │ native capture: crash, ANR, hang, exit,   │
 │ no-op on web                            │  state event │ WebView death, app.start, memory, network │
 └────────────────────────────────────────┘              └──────────────────────────────────────────┘
```

Terms (JS core, native core, hand-off, segment, exempt set) = Cordova §1. **Trace root** = the single ambient root span X1 keeps in JS.

## 2. Packaging — K

- **K1** Three packages, names unchanged, all `5.0.0`: `@nathanclaire/rum` (core), `@nathanclaire/rum-capacitor` (**required**, sole sink), `@nathanclaire/rum-angular` (peer: core + `-capacitor`, Angular ≥ 16). ([040 §5–6](decisions.md#adr-040--public-api-and-configuration-for-500-80), [041 §4](decisions.md#adr-041--4x--50-migration-path-100))
- **K2** Native plugin registered as `EdgeRum` (was `EdgeRumCapacitor`); one plugin, JS + native always shipped together. ([040 §6](decisions.md#adr-040--public-api-and-configuration-for-500-80))
- **K3** Native core = port of the Cordova native core (Cordova A1, T2–T9, W3, W4) into the Capacitor plugin: Android Kotlin under `com.nathanclaire.rum`, iOS Swift via `Package.swift`. PLCrashReporter + NDK `.so` kept; `FrameSampler.swift` / `FrameSampler.kt` deleted. ([034 §1](decisions.md#adr-034--contract-4-fit-native-core-owns-identity-outbox-and-send-web-is-a-no-op-76), [036 §5–6](decisions.md#adr-036--lightweight-budget-and-modular-architecture-78))
- **K4** JS removed: `PayloadBuilder`, `RetryTransport`, `OfflineQueue`, `sendBeacon` path, `locationResolver`, JS `SessionManager`/`SessionIdGenerator`, `memory-web.ts`, `pageload.ts`. `sideEffects: false`; `@capacitor/*`, `@angular/*` peers. ([034 §1](decisions.md#adr-034--contract-4-fit-native-core-owns-identity-outbox-and-send-web-is-a-no-op-76), [036 §4–6](decisions.md#adr-036--lightweight-budget-and-modular-architecture-78), [037 §1](decisions.md#adr-037--event-catalogue-for-500-cordova-names-as-baseline-gap-fills-ionic-only-captures-79))
- **K5** Angular public exports: `provideEdgeRum`, `EdgeRumModule`, `EdgeRumService`, types only. `RouterCapture`, `IonicLifecycleCapture`, `EdgeRumErrorCapture`, `EDGE_RUM_CONFIG`, `edgeRumInitializerFactory`, `ERROR_ROUTE_PROVIDER`, `LIFECYCLE_EVENT_SOURCE` → internal. ([040 §5](decisions.md#adr-040--public-api-and-configuration-for-500-80))

## 3. Architecture and bridge — A

- **A1** = Cordova A1 (native owns config, identity, `device_id`, session + rotation, sampling roll, caps, user/attr persistence, enabled state, outbox, sender, envelope; JS owns WebView capture, `beforeSend`, global attrs, buffer). ([034 §1](decisions.md#adr-034--contract-4-fit-native-core-owns-identity-outbox-and-send-web-is-a-no-op-76), [036 §2](decisions.md#adr-036--lightweight-budget-and-modular-architecture-78))
- **A2** Plugin methods = Cordova A2 action table, as Capacitor plugin methods instead of `exec`: `getState`, `enqueue`, `configure`, `identify`, `clearUser`, `enable`, `disable`, `reset`, `markPhase`; `subscribe` → `addListener('state', …)` (session rotation / enabled changes). **Plus** `setRoot({ trace.id, rum.action.id, trace.root_type } | null)` (X10) and the existing `setLastScreen`. Method names internal, not public API; Q2 pins the table. ([034](decisions.md#adr-034--contract-4-fit-native-core-owns-identity-outbox-and-send-web-is-a-no-op-76), [035 §11](decisions.md#adr-035--trace-model-ambient-root-fetchxhr-injection-native-crash-annotation-77))
- **A3** Breadcrumbs = Cordova A3. ([034](decisions.md#adr-034--contract-4-fit-native-core-owns-identity-outbox-and-send-web-is-a-no-op-76))
- **A4** Before `getState` resolves: JS buffers captures (= Cordova A4, cap 500, drop-oldest, counted), injects **no** `traceparent` (X7 `skipped_no_session`), never blocks startup. No JS fallback sender. ([036 §2](decisions.md#adr-036--lightweight-budget-and-modular-architecture-78), [037 §4](decisions.md#adr-037--event-catalogue-for-500-cordova-names-as-baseline-gap-fills-ionic-only-captures-79))
- **A5** `app.start` assembled natively = Cordova A5 with Capacitor phases: process start → WebView created → `responseEnd` → `DOMContentLoaded` → `load` → bridge ready → optional `markReady()`. No `deviceready`. Carries the `launch` root (X2). ([037 §2](decisions.md#adr-037--event-catalogue-for-500-cordova-names-as-baseline-gap-fills-ionic-only-captures-79))
- **A6** WebView death: Android `WebViewListener.onRenderProcessGone`; iOS JS-reload heuristic (= Cordova A6 inference path; **no swizzle**). ([037 §2](decisions.md#adr-037--event-catalogue-for-500-cordova-names-as-baseline-gap-fills-ionic-only-captures-79))
- **A7** Web is a silent no-op (R16, Cordova A8): every method exists, nothing captured or sent, one debug warning. `device.platform=web` gone. ([034 §2](decisions.md#adr-034--contract-4-fit-native-core-owns-identity-outbox-and-send-web-is-a-no-op-76))
- **A8** Every capture loop, timer and listener the SDK owns runs **outside NgZone** (frame loop, hand-off timer, idle checks). ([036 §5](decisions.md#adr-036--lightweight-budget-and-modular-architecture-78))

## 4. Wire contract fit — W

- **W1** `sdk.name = "ionic"`, `contract_version = "4.0.0"`, `sdk.version` = package version. `sdk.platform`, `location`, `app.environment` never sent. ([034 §5](decisions.md#adr-034--contract-4-fit-native-core-owns-identity-outbox-and-send-web-is-a-no-op-76))
- **W2** App identity = Cordova W3 (native, no override; nil → omitted). ([034 §3](decisions.md#adr-034--contract-4-fit-native-core-owns-identity-outbox-and-send-web-is-a-no-op-76))
- **W3** `device_id` = Cordova W4. Fresh UUID on first 5.0 launch; 4.x localStorage ids (`edge_rum_device_id` et al.) deleted, never carried over. ([034 §4](decisions.md#adr-034--contract-4-fit-native-core-owns-identity-outbox-and-send-web-is-a-no-op-76))
- **W4** No contract amendment (R2 already lists `ionic`). Backend changes = §14. ([034](decisions.md#adr-034--contract-4-fit-native-core-owns-identity-outbox-and-send-web-is-a-no-op-76), [038](decisions.md#adr-038--backend-changes-to-surface-ionic-50-events-and-traces-81))

## 5. Traces — X

Wire byte-identical to Android trace v3 (`edge_telemetry_android/docs/specs/backend-wire-contract.md`) except X7's two extra outcome values.

- **X1** Carrier = one ambient mutable root, read synchronously in the fetch/XHR patches. Lazy expiry: 2 s idle, 10 s cap; idle clock extends on child start and request completion. No Zone.js, no AsyncContext, no public override. ([035 §1](decisions.md#adr-035--trace-model-ambient-root-fetchxhr-injection-native-crash-annotation-77))
- **X2** Root types + mint points: `launch` (start = `performance.timeOrigin`, exempt from idle expiry until first resume); `interaction` (document capture-phase click, before app handler, always replaces; 50 ms-deduped clicks don't mint); `navigation` (Router `NavigationStart`, only when no root live; `ionViewWillEnter` never mints); `request` (when no root live); `resume` (`appStateChange` → active). No `custom`. ([035 §2–3](decisions.md#adr-035--trace-model-ambient-root-fetchxhr-injection-native-crash-annotation-77))
- **X3** Injection = global `fetch` + `XMLHttpRequest` patches only (covers `HttpClient` on either backend and CapacitorHttp-patched globals; ours wraps the bridge's). Copy, never mutate, consumer `Request`/`Headers`. SDK's own endpoint excluded. No interceptor, no direct `CapacitorHttp.request()` wrap. ([035 §4](decisions.md#adr-035--trace-model-ambient-root-fetchxhr-injection-native-crash-annotation-77))
- **X4** `traceHostAllowlist: string[]` = Android allowlist rules verbatim: empty default (inject nowhere) + one debug warning; exact or dot-anchored suffix (`.example.com`); ≥ 2 labels; no substring, no RegExp; ports ignored; matched against the P2-templated URL. Docs state `Access-Control-Allow-Headers: traceparent`. ([035 §5](decisions.md#adr-035--trace-model-ambient-root-fetchxhr-injection-native-crash-annotation-77), [039 §2](decisions.md#adr-039--privacy-hooks-and-sampling-for-500-95))
- **X5** Header flags always `01`; sampled-out sessions send no header (no `-00`). A valid consumer-set header → `adopted` (`span.id` mirrors foreign parent-id; `rum.action.id` stays the local root's `span.id`); malformed → overwritten. ([035 §6–8](decisions.md#adr-035--trace-model-ambient-root-fetchxhr-injection-native-crash-annotation-77))
- **X6** Children of the live root: each Capacitor plugin call (the `nativePromise` wrap, E18) and router guard / resolver / lazy-chunk phases (E19). Ionic page transitions are not children; `screen.duration` annotation-only. ([035 §9](decisions.md#adr-035--trace-model-ambient-root-fetchxhr-injection-native-crash-annotation-77))
- **X7** `traceparent.outcome` = Android's 6 values in Android precedence, plus `skipped_no_cors` (`mode:'no-cors'`, right after `skipped_off_allowlist`) and `skipped_no_session` (before `getState`, A4; row still gets `trace.id`/`span.id` once the session lands). 8 values. ([035 §6](decisions.md#adr-035--trace-model-ambient-root-fetchxhr-injection-native-crash-annotation-77), [037 §4](decisions.md#adr-037--event-catalogue-for-500-cordova-names-as-baseline-gap-fills-ionic-only-captures-79))
- **X8** Key tiers: **Tier 1** (full span keys) on `interaction`/`navigation` root events, `http.request`, bridge/router children. **Tier 2** (`trace.id`, `rum.action.id`, `trace.root_type`) on JS + native `app.crash`, `app.hang`/`app.anr`, `custom_event`, `screen.duration`. **None** on metric items, `app.start` phases, `app_lifecycle`, `session.*`, `user.profile.update`. `http.request` stamps `span.start_time` at send (anchored to `performance.now()`). ([035 §10](decisions.md#adr-035--trace-model-ambient-root-fetchxhr-injection-native-crash-annotation-77))
- **X9** Root cleared on background and session rotation (later requests → `injected_expired`). Ids from `crypto.getRandomValues`; all-zero rejected. Redirect limitation documented (3xx to off-allowlist host keeps the header). ([035 §12](decisions.md#adr-035--trace-model-ambient-root-fetchxhr-injection-native-crash-annotation-77))
- **X10** Native stitch = annotation only: on root mint/replace JS calls `setRoot` once (none per request or frame). Native keeps a non-parenting `lastRoot`, persists it with crash records; replayed native crash/hang/ANR/WebView death carries Tier-2 keys + `trace.root_expired=true` when stale. Native mints no spans. ([035 §11](decisions.md#adr-035--trace-model-ambient-root-fetchxhr-injection-native-crash-annotation-77))

## 6. Lightweight budgets — L

- **L1** size-limit, gzip, CI-fail: core **14 KB**, `-capacitor` own **7 KB**, `-angular` own **4 KB**, full stack deduped **24 KB**, **minimal** (`init` + errors + requests) **8 KB**. Raising a ceiling needs an ADR line. ([036 §3](decisions.md#adr-036--lightweight-budget-and-modular-architecture-78))
- **L2** Tree-shakeable imported captures (C3). Core always includes errors, fetch/XHR + traces, session/native relay. No lazy `import()` of captures. ([036 §4](decisions.md#adr-036--lightweight-budget-and-modular-architecture-78))
- **L3** Runtime ceilings (Playwright + CDP, 4× CPU throttle, median of 5, every PR, absolute): eval + `init()` ≤ 8 ms; `track()` ≤ 10 µs; SDK idle script ≤ 1 ms per 10 s static screen; JS heap after init + 2,000 events ≤ +2 MB. Native load, IPA/APK delta, battery → measured per release in release notes, not gated. ([036 §7](decisions.md#adr-036--lightweight-budget-and-modular-architecture-78))
- **L4** No OpenTelemetry dependency; trace ids/spans hand-rolled (X1–X10). `noExternal` OTel bundle rule retired. ([036](decisions.md#adr-036--lightweight-budget-and-modular-architecture-78))

## 7. Event catalogue — E

**Baseline: Cordova §5 E1–E32 name-for-name and key-for-key**, with the deltas below. Ionic only adds; it never renames a shared concept. ([037 §1](decisions.md#adr-037--event-catalogue-for-500-cordova-names-as-baseline-gap-fills-ionic-only-captures-79))

| # | Cordova row | Ionic delta |
|---|---|---|
| E1 | E1 `session.*` | Same. Counters last-write on backend (G8). |
| E2 | E2 `app_lifecycle` | Source = Capacitor `appStateChange` + native fg/bg. `lifecycle.state`. |
| E3 | E3 `app.start` | Phases per A5. Replaces 4.x `page_load` + `lifecycle.cold_start_ms`. Exempt. |
| E4 | E4 `navigation` | Source = Angular Router (normalised route template, never raw URL); `trackScreen()` for non-Angular apps. Plus E19 phase keys. |
| E5 | E5 `screen.duration` | Ionic page lifecycle via **capture-phase** listener (4.x bubbling bug fixed). Tier-2 keys. |
| E6 | E6 `http.request` | fetch + XHR (incl. `HttpClient`, 4.x XHR gap fixed); URL per P2; `http.{request_size,response_size}` where available; `success` = 200–399; X7/X8 keys. |
| E7 | E7 `resource_timing` | `resourceTiming()` opt-in; **aggregate** per screen window grouped by templated host: `resource.{initiator_type,count,p95_ms,transfer_kb}`. No per-resource URLs; CapacitorHttp proxy + SDK endpoint excluded. |
| E8 | E8 `traceparent` | §5. |
| E9–E11 | `app.crash` JS | Same; `consoleErrors()` **in** `defaultCaptures()` (Cordova default off). `release` per Y2. |
| E12 | E12 native crash | Same (PLCrashReporter iOS, JVM + NDK Android). X10 keys. |
| E13 | E13 `WebViewTerminated` | Detection per A6; `webview.detected_by ∈ callback\|inference`. Exempt. |
| E14 | E14 `app.anr` | Android, native config `anr`/`anrTimeoutMs` (5000). |
| E15 | E15 `app.hang` | **Added on Android**; both platforms 2 s default (iOS 5 s → 2 s). No JS-thread hang detector. |
| E16 | E16 `app.exit` | Same (Android `ApplicationExitInfo`, next launch). |
| E17 | E17 `cordova.deviceready_timeout` | **Not emitted** (no `deviceready`). |
| E18 | E18 `bridge.summary` | Source = `Capacitor.nativePromise` wrap; keys = Cordova E18 (`bridge.service` = plugin name, `bridge.action` = method, `bridge.{count,error_count,p50_ms,p95_ms,max_ms}`) + additive `bridge.error_codes`; SDK's own plugin excluded. Export `bridge()`, default on. **No `bridge.call`** (Cordova E19 not emitted). |
| E19 | — | Router phases on `navigation`: `navigation.{guards_ms,resolvers_ms,chunk_load_ms}`; X6 children. Angular, default on. |
| E20 | E20 `frame.summary` | rAF only, **idle-paused** after 2 s with no input/scroll/route change/Ionic transition; ADR-030 windowed shape, `frame.*` keys, `frame.source=raf`. `frames({ slowThresholdMs })`, default on. |
| E21 | E21 web vitals | `vitals()`, default on. Backend WebView vitals panel (G7). |
| E22–E24 | memory | Bookends + `memory_pressure` always on (native); periodic sampling = native config `memorySampling` (off, 30 s). `memory.*` keys. |
| E25 | E25 `ui.interaction` | `interactions()`; rage/dead per Cordova; name per P4. |
| E26 | E26 `network_change` | Native. |
| E27–E31 | API events + `sdk.health` | Same (`task.complete` via `startTask`/`completeTask`/`failTask`). `user.profile.update` sampled (S2). |
| E32 | E32 context | Plus always-on context attrs `webview.version`, `app.bundle_id` (P5). |
| E33 | — | `ionicUi()` (**off**): `ui.interaction` with `ui.type ∈ overlay_open\|overlay_dismiss\|tab_change\|back\|keyboard_show`, `ui.target` = component tag. |
| E34 | — | Angular route error: `app.crash cause=NavigationError`, unchanged from 4.x. |

Never emit `page_load`, `user.interaction`, `frame_render_time`, `bridge.call`, `cordova.deviceready_timeout`. Skipped: view rollup, `screen.load`, `storage_usage`, `cpu_usage`, `sdk.health` as standalone capture beyond R4, change-detection cost, `nativeCallback` counts, Capgo rollback events, session replay. ([037 §2–5](decisions.md#adr-037--event-catalogue-for-500-cordova-names-as-baseline-gap-fills-ionic-only-captures-79), [036 §5–6](decisions.md#adr-036--lightweight-budget-and-modular-architecture-78), [040 §1–2](decisions.md#adr-040--public-api-and-configuration-for-500-80))

## 8. Naming and keys — N

- **N1** = Cordova N1 (processor extractor keys) and N3. Renames from 4.x: `user.interaction` → `ui.interaction`; `frame_render_time` → `frame.summary`; `app.crash cause=ANR|Hang` → `app.anr`/`app.hang`; dotless memory keys → `memory.*`; `metric.screen` → `screen.name`; `lifecycle.event` → `lifecycle.state`; battery camelCase → snake_case. ([037 §1](decisions.md#adr-037--event-catalogue-for-500-cordova-names-as-baseline-gap-fills-ionic-only-captures-79))
- **N2** Ionic-only keys stay dotted: `bridge.*`, `navigation.{guards_ms,resolvers_ms,chunk_load_ms}`, `resource.*`, `webview.*`, `app.bundle_id`, `app.start.*`, `trace.root_expired`, `release`. ([037](decisions.md#adr-037--event-catalogue-for-500-cordova-names-as-baseline-gap-fills-ionic-only-captures-79))
- **N3** Terminology firewall (`CLAUDE.md` Rule 1, rewritten): banned in public surface = `opentelemetry`, `otel`, `otlp`, `TracerProvider`, `SpanProcessor`, `SpanExporter`, `MeterProvider`, `LoggerProvider`, `tracer`; brand-voice bans (`telemetry`, `metric(s)` in API names, `instrumentation`, `sampling`, `batch`, `flush`, `collector`, `pipeline`) stay. `trace`, `span`, `tracing`, `traceparent` allowed. ([033](decisions.md#adr-033--terminology-firewall-narrowed-to-opentelemetry-identity-tracespan-allowed-75))
- **N4** Guard tests: `scripts/terminology-check.mjs` unchanged; `test/docs-terminology.test.ts` drops `span`/`tracer`/`tracing` (`tracer` kept only in the OTel set); payload tests keep banning camelCase `traceId`/`spanId`/`resourceSpans`/`opentelemetry`; new test pins dotted `trace.id`/`span.id`/`traceparent.outcome` on `http.request`. ([033 §4](decisions.md#adr-033--terminology-firewall-narrowed-to-opentelemetry-identity-tracespan-allowed-75))

## 9. Configuration and public API — C

- **C1** Native config `capacitor.config.ts` → `plugins.EdgeRum`, read at launch: `apiKey`, `endpoint`, `enabled` (`true`; `false` = opt-in, P7), `sampleRate` (`1.0`), `anr`/`anrTimeoutMs` (`true`/`5000`), `hang`/`hangTimeoutMs` (`true`/`2000`), `memorySampling`/`memorySamplingIntervalMs` (`false`/`30000`), `debug`. Missing key/endpoint = Cordova C1 (capture to disk, send after `configure`). ([040 §1](decisions.md#adr-040--public-api-and-configuration-for-500-80))
- **C2** `EdgeRum.init(opts?)` / `provideEdgeRum(opts?)`, JS-only: `apiKey?`/`endpoint?` (runtime, not persisted), `captures` (default `defaultCaptures()`), `traceHostAllowlist: string[]`, `ignoreUrls`, `sanitizeUrl`, `beforeSend`, `release?`, `debug`. Per-capture knobs are factory args. No other knobs. ([040 §1](decisions.md#adr-040--public-api-and-configuration-for-500-80))
- **C3** Capture exports: core `vitals()`, `interactions()`, `frames()`, `longTasks()`, `resourceTiming()`, `consoleErrors()`, `defaultCaptures()`; `-capacitor` `bridge()`; `-angular` `ionicUi()`. `defaultCaptures()` = `vitals`, `interactions`, `frames`, `longTasks`, `consoleErrors`, `bridge` (today's 4.x set minus resource timing, ADR-037 §5) (+ Angular router/lifecycle/error capture auto-wired by `provideEdgeRum`). `memory()` is **not** a JS export (C1). ([036 §4](decisions.md#adr-036--lightweight-budget-and-modular-architecture-78), [040 §1–2](decisions.md#adr-040--public-api-and-configuration-for-500-80), [037 §3](decisions.md#adr-037--event-catalogue-for-500-cordova-names-as-baseline-gap-fills-ionic-only-captures-79))
- **C4** Removed 4.x fields: `appName`, `appVersion`, `appPackage`, `appBuild`, `environment`, `location`, `resolveLocation`, `locationProviderUrl`, `maxQueueSize`, `flushIntervalMs`, `batchSize`, `deferFlush`, `awaitNativeInstall`, `captureNativeCrashes`, `captureFrames`, `captureAllFrames`, `frameSlowThresholdMs`, `captureConsoleErrors`, every `captureX` boolean, `enableAnrDetection`/`enableHangDetection`/`anrTimeoutMs`/`hangTimeoutMs` (→ C1). ([040 §2](decisions.md#adr-040--public-api-and-configuration-for-500-80))
- **C5** `init()` fails open: never throws on missing/malformed `apiKey` (debug warning only). ([040 §3](decisions.md#adr-040--public-api-and-configuration-for-500-80))
- **C6** Methods = Cordova C4 verbatim (sync, fire-and-forget, safe before native ready, no-op on web), incl. async `getSessionId(): Promise<string>`. Global attributes (`setAttribute`) stamp JS events only. No manual span/action API. `EdgeRumService` mirrors every method, no logic. ([040 §4](decisions.md#adr-040--public-api-and-configuration-for-500-80))
- **C7** Angular: `provideEdgeRum(opts)` → `EnvironmentProviders`, primary; `EdgeRumModule.forRoot` one-line wrapper; `APP_INITIALIZER`; no HttpClient interceptor; `ErrorHandler` chains to any host-provided handler. Non-Angular Capacitor apps: core + `-capacitor`, `EdgeRum.init()`, README `trackScreen` recipe. ([040 §5–6](decisions.md#adr-040--public-api-and-configuration-for-500-80))

## 10. Transport — T

- **T1** = Cordova T1–T9 (hand-off cadence, NDJSON outbox, seal, frozen identity, R13 timestamp, gzip always + `Content-Encoding: gzip`, R12 retries, caps, drops → `sdk.health`, no knobs). JS hand-off triggers: 2 s / 20 events, `visibilitychange→hidden`, `appStateChange → inactive`, any captured `app.crash`. ([034 §1](decisions.md#adr-034--contract-4-fit-native-core-owns-identity-outbox-and-send-web-is-a-no-op-76), [036 §1](decisions.md#adr-036--lightweight-budget-and-modular-architecture-78))
- **T2** `CLAUDE.md` Rule 2 rewritten: "JSON only; gzip on the wire, applied by the native sender." ([036 §1](decisions.md#adr-036--lightweight-budget-and-modular-architecture-78))

## 11. Sampling and caps — S

- **S1** = Cordova S1, S3, S5–S8 (one native session roll, `sampleRate` from C1 only, `session.sampled` when rate < 1, gate + caps at outbox append). No separate trace rate. ([039 §3](decisions.md#adr-039--privacy-hooks-and-sampling-for-500-95))
- **S2** Exempt set = Cordova S2 with `cordova.deviceready_timeout` removed and WebView death included. `user.profile.update` is **not** exempt (ADR-019 superseded). ([039 §3](decisions.md#adr-039--privacy-hooks-and-sampling-for-500-95))
- **S3** Caps = Cordova S4 with `bridge.call` row replaced by `bridge.summary` 50/session; drops → `sdk.health` `cap.*` reasons. ([039 §3](decisions.md#adr-039--privacy-hooks-and-sampling-for-500-95))

## 12. Privacy and consent — P

- **P1** `beforeSend` = Cordova P5 (JS events only, incl. `bridge.summary` + router phases; native-origin events bypass, documented). ([039 §1](decisions.md#adr-039--privacy-hooks-and-sampling-for-500-95))
- **P2** URLs = Cordova P1 + `http.url` templating (digits or ≥ 32 chars → `{id}`, `vN` kept, depth ≤ 6), then remove-only `sanitizeUrl` (throw → templated URL kept). CapacitorHttp proxy URLs (`_capacitor_http_interceptor_?u=`) unwrapped first. `ignoreUrls` kept. Screen names from Angular route templates; **no `screenName()`**. ([039 §2](decisions.md#adr-039--privacy-hooks-and-sampling-for-500-95), [037 §2](decisions.md#adr-037--event-catalogue-for-500-cordova-names-as-baseline-gap-fills-ionic-only-captures-79))
- **P3** Headers and bodies never captured (Cordova P3). ([039 §4](decisions.md#adr-039--privacy-hooks-and-sampling-for-500-95))
- **P4** `ui.target` = Cordova P4 (supersedes ADR-025). `ionicUi()` target = component tag only. ([039 §4](decisions.md#adr-039--privacy-hooks-and-sampling-for-500-95))
- **P5** `bridge.summary`: plugin + method, counts, durations, error code/class — never options, results, messages. Router phases: guard/resolver class names + route template, never params or resolved data. `app.bundle_id` = last segment of `getServerBasePath()` or `builtin`. ([039 §4](decisions.md#adr-039--privacy-hooks-and-sampling-for-500-95))
- **P6** Errors: message + stack unscrubbed; breadcrumbs reuse P2/P4 rules. ([039 §4](decisions.md#adr-039--privacy-hooks-and-sampling-for-500-95))
- **P7** Consent + identity = Cordova P6 + P7 (`enabled: false` opt-in via C1; `disable()`, `reset()`, `clearUser()` semantics). ([039 §5](decisions.md#adr-039--privacy-hooks-and-sampling-for-500-95), [040 §4](decisions.md#adr-040--public-api-and-configuration-for-500-80))

## 13. Symbols — Y

- **Y1** Wire-ready only (Cordova Y1): no upload CLI, Xcode phase, Gradle task, upload API, Debug IDs. ([042 §1](decisions.md#adr-042--release-identity-and-symbol-upload-for-50-101))
- **Y2** `release` has no default; stamped only on JS-origin `app.crash` (unhandled + `captureError`). ([042 §2–3](decisions.md#adr-042--release-identity-and-symbol-upload-for-50-101))
- **Y3** JS frames → `app:///` = Cordova Y2 (origins incl. `capacitor://localhost`, `https://localhost`, `http://localhost`). JS map key = `release` ?? `app.bundle_id` + normalised path; native key = `app.version` + `app.build_number`; native frame formats = Cordova Y3. ([042 §4](decisions.md#adr-042--release-identity-and-symbol-upload-for-50-101), [039 §4](decisions.md#adr-039--privacy-hooks-and-sampling-for-500-95))
- **Y4** OTA: docs recipe setting `release` from Capgo/Appflow bundle version at build time. No vendor hook. ([042 §5](decisions.md#adr-042--release-identity-and-symbol-upload-for-50-101))

## 14. Backend — G

Repos: `edge_telemetry_processor_go` (proc), `edge_telemetry_analytics_go` (analytics). Collector: no change. No 4.x-name aliases. ([038](decisions.md#adr-038--backend-changes-to-surface-ionic-50-events-and-traces-81))

- **G0** Gate: verify prod runs collector PR #8 + processor PR #9 (else contract-4 batches DLQ as `<app-not-registered>`).
- **G1** proc: fatal `app.crash`/`app.anr`/`app.hang` (incl. `WebViewTerminated`, `app.exit`) → `rum_crash_events`; `rum_errors` keeps non-fatal. All SDKs.
- **G2** proc: `traceparent.outcome` → `rum_http_requests.trace_injection`; enum + `skipped_no_cors`, `skipped_no_session`.
- **G3** proc: `rum_sessions.sdk_name`, `sdk_version`, `webview_version`, `app_bundle_id` (first-write).
- **G4** proc + analytics: navigation written to the table analytics reads; nullable `guards_ms`, `resolvers_ms`, `chunk_load_ms`; "route resolve" breakdown, hidden when null.
- **G5** proc + analytics: typed `rum_bridge_summaries` for `bridge.summary` — one table for Ionic + Cordova (shares `edge_telemetry_processor_go#19`); "Native plugin calls" panel (p95 + error rate by service.action, screen filter).
- **G6** analytics: frames view reads `processor_frame_summaries`; memory view reads `memory.*` + `memory_pressure`; legacy `frame_render_time` via `metric_name` filter.
- **G7** proc + analytics: `rum_performance_metrics.metric_name`/`value` from top-level fields; `metric.rating` column; mobile "WebView vitals" panel.
- **G8** proc: `rum_sessions.event_count`/`screen_count`/`visited_screens` last-write from `session.finalized`.
- **G9** Legacy `telemetry_batch` 3.1 ingest kept, no sunset date. ([041 §3](decisions.md#adr-041--4x--50-migration-path-100))
- **G10** Ordering: G0 → proc halves of G1–G5, G7, G8 live **before** Ionic 5.0 ships → analytics may trail.

## 15. Migration — M

- **M1** Clean break: no 4.x deprecation minor, no config shim, no removed-key warnings. 4.x frozen at 5.0 GA, no `release/4.x` branch. ([041 §1–2](decisions.md#adr-041--4x--50-migration-path-100))
- **M2** `docs/migration-5.md` (guide only, no codemod) covering the ADR-041 §5 list: backend prerequisite, install + plugin rename, config before/after table (C1, C4), Angular (C7, K5), API (C5, C6), data continuity (W3, N1), web no-op (A7). ([041 §5](decisions.md#adr-041--4x--50-migration-path-100))
- **M3** Repo docs rewritten at implementation: `CLAUDE.md` (Rules 1–2, envelope, ID formats, eventName table, offline queue, bundle rules, config block), `docs/payload-schema.json`, `docs/terminology.md`, `docs/config-reference.md`, READMEs. ([033](decisions.md#adr-033--terminology-firewall-narrowed-to-opentelemetry-identity-tracespan-allowed-75), [034](decisions.md#adr-034--contract-4-fit-native-core-owns-identity-outbox-and-send-web-is-a-no-op-76), [036](decisions.md#adr-036--lightweight-budget-and-modular-architecture-78), [037](decisions.md#adr-037--event-catalogue-for-500-cordova-names-as-baseline-gap-fills-ionic-only-captures-79))

## 16. Tests — Q

- **Q1** = Cordova Q1–Q6 with swaps: `cordova.exec` stub → fake Capacitor bridge; Q2 Playwright harness (`e2e/`) sends via the fake bridge to mock-ingest and hosts the L3 bench; Q5 example = `demo/` upgraded to an Ionic Angular app using `provideEdgeRum`, one button/deep link per scenario; checks use `sdk.name=ionic`. ([043 §1](decisions.md#adr-043--test-strategy-and-coordinated-rollout-for-50-102))
- **Q2** Golden batch per event type in native JUnit/XCTest; same files copied as fixtures into `edge_telemetry_processor_go`, asserting each Ionic event lands in its G-column. Golden change ⇒ paired processor fixture PR. ([043 §2](decisions.md#adr-043--test-strategy-and-coordinated-rollout-for-50-102))
- **Q3** Device e2e (emulator + simulator, nightly, required on release tag) = Cordova Q4 + `navigation` router phase keys, `HttpClient` XHR captured, allowlisted request carries `traceparent` with outcome recorded. ([043 §3](decisions.md#adr-043--test-strategy-and-coordinated-rollout-for-50-102))

## 17. Release — V

- **V1** CI = Cordova V1 with fixture `npx cap add android|ios` + native build (macOS job for iOS), plus L1 size-limit and L3 bench. ([043 §1](decisions.md#adr-043--test-strategy-and-coordinated-rollout-for-50-102))
- **V2** Release workflow, version injection, CHANGELOG = Cordova V2–V4 across all three packages. ([043](decisions.md#adr-043--test-strategy-and-coordinated-rollout-for-50-102))
- **V3** Rollout: G0/G10 gate is a box in `docs/release-checklist.md`, ticked in the release PR → `5.0.0-rc.N` on npm `next` → one internal pilot app in prod ~1 week → GA when pilot batches land in G tables with zero DLQ. GA freezes 4.x (M1). ([043 §4](decisions.md#adr-043--test-strategy-and-coordinated-rollout-for-50-102))

---

## 18. Reconciled conflicts

| Conflict | Resolution |
|---|---|
| ADR-036 §6 watchdog/memory switches in the JS capture list | Native config (C1), ADR-040 §1 amendment. `memory()` not a JS export. |
| ADR-035 §10 "None" tier lists `page_load` | `page_load` gone (E3); `app.start` takes its place in the None tier. |
| ADR-034 §1 "session/sampling placement → #78" | Native (A1, ADR-036 §2). |
| ADR-037 §2 `task.complete` "API → #80" | `startTask`/`completeTask`/`failTask` (C6). |
| Cordova C2 `captureX` booleans, `correlateRequestsTo`, `screenName()`, `slowBridgeCallMs` | Ionic uses imported captures (C3), `traceHostAllowlist` (X4), no `screenName()` (P2), no `bridge.call` (E18). Intentional mechanism divergence; shared wire unaffected. |
| ADR-019 `user.profile.update` exempt | Not exempt (S2). |
| ADR-025 no interaction text | Cordova P4 text (P4). |
| ADR-036 §4 "`defaultCaptures()` = today's behaviour" vs ADR-037 §5 resource timing opt-in | Today's set minus `resourceTiming` (C3). |
| ADR-037 §3 `ionicUi()` / `bridge()` package unstated | `bridge()` in `-capacitor` (wraps `Capacitor.nativePromise`); `ionicUi()` in `-angular` beside `IonicLifecycleCapture` (C3). |
| ADR-037 §3 `bridge.{plugin,method}` vs Cordova E18 `bridge.{service,action}` on the same `bridge.summary` | ADR-037 §1 wins (never rename a shared concept): Cordova keys, plugin → `service`, method → `action`; `bridge.error_codes` additive (E18). |
| ADR-030 native frame samplers | Deleted (K3, E20). |
| `CLAUDE.md` "backend drops unknown names" | Wrong — unknown names land in `rum_telemetry_events`; corrected in M3. |

## 19. Implementation order

Issues on this repo labelled `ready-for-agent`; backend issues labelled `ready-for-dev` in their repos. Blocking is native GitHub "blocked by" (cross-repo edges included). Each issue lists the rules it realizes.

```
01 Scaffold ─┬─▶ 02 And core ─▶ 03 And session ─▶ 04 And crash/ANR/hang ─▶ 05 And WebView/start ─┐
             ├─▶ 06 iOS core ─▶ 07 iOS session ─▶ 08 iOS crash/hang ─────▶ 09 iOS WebView/start ─┤
             └─▶ 10 JS core ─┬─▶ 11 errors ─────────────────────────────────────────────────────┤
                             ├─▶ 12 network ─▶ 13 traces ──────────────────────────────────────┼─▶ 17 demo + device e2e ─┐
                             ├─▶ 14 Angular ───────────────────────────────────────────────────┤                         ├─▶ 18 docs + publish 5.0.0
                             ├─▶ 15 interactions ──────────────────────────────────────────────┤                         │
                             └─▶ 16 performance ───────────────────────────────────────────────┘                         │
 P1 prod gate ─────────────────────────────────────────────────────────────────────────────────────────────────────────┤
 P2 crash/nav/sessions ─┬───────────────────────────────────────────────────────────────────────────────────────────────┤
 P3 trace/session/metric ┼──────────────────────────────────────────────────────────────────────────────────────────────┤
 P4 bridge table+goldens ┴─▶ A1 analytics panels (may trail GA) ────────────────────────────────────────────────────────┘
```

| # | Issue | Rules | Blocked by |
|---|---|---|---|
| [01](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/107) | Package restructure, plugin rename, size budgets, CI checks | K1, K2, K5, L1, L4, N3, N4, V1 | — |
| [02](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/108) | Android native core — identity, envelope, outbox, gzip sender | A2, W1–W3, T1, T2, Q2 | 01 |
| [03](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/109) | Android session, sampling, caps, consent, user store | A1, A2, C1, E1, E31, S1–S3, P7 | 02 |
| [04](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/110) | Android crash, ANR, hang, exit, breadcrumbs, root annotation | A3, E12, E14–E16, X10, Y3 | 03 |
| [05](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/111) | Android WebView death, app.start, lifecycle, memory, network | A5, A6, E2, E3, E13, E22–E24, E26, E32 | 04 |
| [06](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/112) | iOS native core | as 02 | 01 |
| [07](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/113) | iOS session, sampling, caps, consent, user store | as 03 | 06 |
| [08](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/114) | iOS crash, hang, breadcrumbs, root annotation | A3, E12, E15, X10, Y3 | 07 |
| [09](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/115) | iOS WebView death heuristic, app.start, lifecycle, memory, network | A5, A6, E2, E3, E13, E22–E24, E26, E32 | 08 |
| [10](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/116) | JS core — buffer, hand-off, API, captures, `beforeSend`, harness | A1, A2, A4, A7, A8, C2–C6, K4, L2, L3, P1, T1, E27–E31, Q1 | 01 |
| [11](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/117) | JS errors, `app:///` frames, breadcrumbs, `release` | E9–E11, A3, Y2, Y3, P6 | 10 |
| [12](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/118) | JS network — fetch/XHR, URL templating, resource timing | E6, E7, P2, P3 | 10 |
| [13](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/119) | JS traces — root, `traceparent`, outcomes, root relay | X1–X10, A2 | 12 |
| [14](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/120) | Angular — `provideEdgeRum`, router + phases, Ionic lifecycle, ErrorHandler | C7, K5, E4, E5, E19, E34, X2, X6 | 10 |
| [15](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/121) | JS interactions + `ionicUi()` | E25, E33, P4, X2 | 10 |
| [16](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/122) | JS performance — app.start, vitals, rAF frames, long tasks, `bridge.summary` | A5, E18, E20, E21, P5, S3 | 10 |
| [17](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/123) | Ionic Angular demo, device e2e, release checklist | Q1, Q3, V3 | 05, 09, 11, 13–16 |
| [18](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/issues/124) | Docs rewrite, migration guide, release workflow, publish 5.0.0 | M1–M3, Y4, V2, V3 | 17, P1–P4 |
| [P1](https://github.com/NCG-Africa/edge_telemetry_processor_go/issues/22) | Verify prod runs collector #8 + processor #9 | G0 | — |
| [P2](https://github.com/NCG-Africa/edge_telemetry_processor_go/issues/23) | Fatal crash routing, navigation table + phase cols, last-write session counters | G1, G4, G8 | — |
| [P3](https://github.com/NCG-Africa/edge_telemetry_processor_go/issues/24) | `trace_injection`, session SDK/WebView cols, metric names | G2, G3, G7 | — |
| [P4](https://github.com/NCG-Africa/edge_telemetry_processor_go/issues/25) | `rum_bridge_summaries` + Ionic golden fixtures | G5, Q2 | — |
| [A1](https://github.com/NCG-Africa/edge_telemetry_analytics_go/issues/65) | Analytics: route resolve, plugin calls, frames/memory, WebView vitals | G4–G7 | P2–P4 |

JS (10–16) builds against the A2 table with the Q1 fake bridge, so it runs in parallel with both native tracks and the backend.

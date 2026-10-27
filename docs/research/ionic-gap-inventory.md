# Ionic gap inventory: edge-rum 4.0.0 vs siblings and contract 4

Ticket #69 (wayfinder map #68). Research only. As of 2026-10-27.

Pins (HEAD read): Ionic `e5b48d4` (v4.0.0) · Android `330cb1d` (4.0.1+#143) · iOS `b8cc022` (4.0.2+#262) · Flutter `d17fc58` (4.1.0+#125) · RN `f5a78a8` (5.0.0) · Cordova `db8ad4d` (pre-release, #32 merged) · processor `488c29a`.

## Summary

Tag counts: 44 capture rows + 16 contract rules = 60.

| Tag | Capture (§1) | Contract (§2) | Total |
|---|---|---|---|
| parity | 14 | 5 | **19** |
| rename | 13 | 4 | **17** |
| missing | 13 | 7 | **20** |
| Ionic-ahead | 4 | 0 | **4** |

Top gaps for 5.0, most important first:

1. **Contract-4 envelope move (R1–R3, R8, R9, R11, S1).** Ionic still sends the legacy envelope `{type, timestamp, location?, batch_size, events}` and puts identity on every event, with `sdk.contract_version: "3.1.0"`. Every other 4.x native SDK (Android, iOS, Flutter, Cordova) sends the 8-key envelope. Only RN 5.0.0 is also legacy. This is the single largest delta.
2. **Traces and spans (C7, C8).** Ionic has no `trace.id`/`span.id`/`rum.action.id`/`trace.root_type`, no `traceparent` injection and no `traceparent.outcome`. Android, Flutter, RN and Cordova (HTTP only) have them. The processor already stores them as columns (P:extract.go:279-289).
3. **Send-policy correctness (R12, R13, R14).**
   - 500/502/504 are dropped as fatal; only 0/429/503 are retried.
   - Queued batches replay with their stored envelope timestamp.
   - Replayed native crashes ride a normal batch stamped with the current build.
   - The `sendBeacon` path sends no `X-API-Key`.
4. **Names the processor routes that Ionic doesn't send (C14, C15, C18, C22).** The processor has child tables for `ui.interaction`, `app.anr`/`app.hang` and `frame.summary` (P:service.go:695,707,745). Ionic sends `user.interaction`, `app.crash`+`cause=ANR|Hang` and metric `frame_render_time`. Those rows reach only the generic `rum_telemetry_events` bag.
5. **Missing launch/stability signals (C16, C17, C36, C39).**
   - No `app.start` event; there is only a JS-only `lifecycle.cold_start_ms` attribute.
   - No WebView render-process death.
   - No `app.exit`.
   - No bridge timing.

   Cordova, the closest sibling and also a WebView-on-native SDK, ships all four.

Also high-value but smaller:
- XHR capture (C6).
- Templated `http.url` (C5).
- Rage/dead clicks (C19).
- `task.complete` (C34).
- R7: Ionic actively ships `location` and an opt-in IP-geo call.
- R16 conflict: Ionic supports `web` and the contract forbids it.

## Citation legend

| Prefix | Path under `/Users/mktowett/Development/edge_rum/` |
|---|---|
| `X:` | `edge_telemetry_ionic_angular_capacitor/packages/` |
| `A:` | `edge_telemetry_android/telemetry_library/src/main/java/com/androidtel/telemetry_library/` |
| `I:` | `edge_telemetry_ios_sdk/Sources/` |
| `F:` / `FA:` / `FI:` | `edge_telemetry_flutter/lib/src/` / `…/android/src/main/kotlin/com/ncgafrica/edge_telemetry_flutter/EdgeTelemetryFlutterPlugin.kt` / `…/ios/Classes/EdgeTelemetryFlutterPlugin.swift` |
| `R:` | `edge_telemetry_react_native/src/` |
| `C:` | `edge_telemetry_cordova_sdk/` (JS in `src/`; native `android/src/main/java/com/nathanclaire/rum/cordova/`, `ios/Sources/EdgeRum/`) |
| `P:` | `edge_telemetry_processor_go/internal/telemetry/` |
| `W:` | `wayfinder/` |

Tag key:
- **parity**: already matches the sibling majority or the backend.
- **rename**: Ionic has it, but the wire name, attribute keys or placement differ.
- **missing**: siblings have it and Ionic doesn't (or, in §2, the rule is not met).
- **Ionic-ahead**: Ionic has it and siblings lack it.

## Verification notes on the secondary sources

`edge_telemetry_cordova_sdk/docs/research/sibling-sdk-telemetry.md` (dated 2026-10-25) is mostly accurate for Android, iOS and Flutter. It has these problems:

- **Stale on RN.** RN 5.0.0 (2026-10-26) removed `navigation` and `screen.duration` in favour of `view` (R:core/telemetry.ts:134-137; `edge_telemetry_react_native/docs/migration-v5.md` breaking change #2). It removed `http.url` in favour of a templated `http.route` (R:adapters/httpAttributes.ts:4-6,88-120). It added `app.hang` and `task.complete` (R:adapters/hangDetector.ts:10-23; R:core/telemetry.ts:1124-1132). The doc lists RN `navigation`/`screen.duration` and has no RN hang or task row (§1 rows "Screen dwell", "Hang").
- **Stale on HTTP URLs.** Android, iOS, Flutter, RN and Cordova now template paths on the device: digits or ≥32 chars become `{id}`, `vN` is kept, depth is capped at 6 (A:core/TelemetryInterceptor.kt:99-117; I:EdgeRumCapture/HTTPCapture.swift:319-325,387-400; F:capture/http_url.dart:14-58; R:adapters/httpAttributes.ts:11-28; C:src/network.ts:16-28). The processor also templates at ingest (P:extract.go:291-293, `domain.TemplateURL`). The doc predates this.
- **Wrong on Android memory and network.**
  - `system_memory_available` is effectively not emitted: it appears only in the unreferenced `TelemetryMemoryUsage.kt` (A:core/TelemetryMemoryUsage.kt:114).
  - `memory_pressure` is sent on every sample (A:core/MemoryTracker.kt:97-112,306-335).
  - Android has no `network_change`; its NetworkCallback only logs (A:core/NetworkCapabilityDetector.kt:113). The doc gets this last point right.
- **Wrong on iOS traces.** The doc implies an iOS trace namespace. In fact iOS has zero trace code: the OTel bridge is a stub (I:EdgeRumOTelBridge/Bridge.swift:1-17). `edge_telemetry_ios_sdk/docs/specs/distributed-trace-v3-ios.md` is "frozen" but unimplemented (its L39: "Zero trace code exists today").
- **No Cordova column.** Cordova today emits `ui.interaction`, `frame.summary`, `app.start`, `app.anr`, `app.hang`, `app.exit`, `task.complete`, `bridge.*` and `sdk.health` (see §1).
- **Stale on Ionic.**
  - The doc says Ionic's `sdk.version=4.0.0`. That is correct (X:core/src/index.ts:1).
  - The Ionic **`sdk-audit.yaml` is stale.** It says `current_version: "3.5.0"` (`edge_telemetry_ionic_angular_capacitor/sdk-audit.yaml:5`) while the package is 4.0.0. ADR-021 also still says `SDK_VERSION ('3.5.0')` (docs/decisions.md:433-435).
- **This repo's CLAUDE.md "Backend silently drops anything else" is wrong for the current processor.** Unknown names keep their `rum_telemetry_events` row and only skip child tables (P:service.go:680-684,713-715). Dropping happens on the SDK side (RN, iOS and Flutter allowlists), not in the backend.

---

## 1. Per-capture table

Format per cell: `wire name` · key attrs · trigger. "—" means not emitted.

### 1a. Screens and navigation

| # | Concept | Ionic 4.0.0 | Android | iOS | Flutter | RN 5.0 | Cordova | Tag |
|---|---|---|---|---|---|---|---|---|
| C1 | Navigation | `navigation` · `navigation.{to_screen,from_screen,method,route_type,has_arguments,timestamp}` · Angular Router + `trackScreen()` (X:angular/src/RouterCapture.ts:90-145; X:core/src/EdgeRum.ts:316-334) | `navigation`, same keys (A:core/TelemetryManager.kt:708-722) | `navigation` · `navigation.{screen,kind,previous_screen}` (I:EdgeRumCapture/UIViewControllerCapture.swift:268-295) | `navigation` · `navigation.{to,from,method,type}` (F:widgets/edge_navigation_observer.dart:146-160) | — removed in v5 (R:core/telemetry.ts:134-137) | `navigation`, same keys as Ionic (C:src/screens.ts:22-34) | **parity**. Matches Android, Cordova and processor `extractNavigation` (P:extract.go:343-350) |
| C2 | Screen dwell | `screen.duration` · `screen.{name,duration_ms,exit_method,timestamp}` · `ionViewDidLeave` (X:core/src/EdgeRum.ts:485; X:angular/src/IonicLifecycleCapture.ts) | `screen.duration` (A:core/TelemetryManager.kt:739-748) | — removed (I:EdgeRumCapture/UIViewControllerCapture.swift:14-15) | on `navigation` as `screen.previous_duration_ms` (F:widgets/edge_navigation_observer.dart:132-135) | `view.time_spent` | `screen.duration` (C:src/screens.ts:37-43) | **parity**. Processor child table (P:service.go:703) |
| C3 | View rollup | — | — | — | — | `view` · `view.{time_spent,loading_time,error_count,action_count,request_count,…}` (R:adapters/viewManager.ts:286-318) | — | **missing** (RN only; low priority) |
| C4 | Screen load / readiness | — | — | M:`screen_ready` · `screen.ready_outcome`, host `markScreenReady()` (I:EdgeRumCore/Riders.swift:76-79,153-190) | `screen.load` · `screen.load.{outcome,source,first_frame_ms,settled_ms}` (F:capture/screen_load_hook.dart:234-262) | `view.loading_time` (R:adapters/viewManager.ts:286-318) | — | **missing** |

### 1b. Network and HTTP

| # | Concept | Ionic 4.0.0 | Android | iOS | Flutter | RN 5.0 | Cordova | Tag |
|---|---|---|---|---|---|---|---|---|
| C5 | HTTP request attrs | `http.request` · `http.{url,method,status_code,duration_ms,success,timestamp}`. URL is the raw path with only sensitive query params stripped; no sizes; `success` = 200-399 (X:core/src/instrumentation/requests.ts:34-36,67-90; X:core/src/instrumentation/url-sanitizer.ts:20-40) | `http.url` templated `host/path`, `http.{request_size,response_size}`, `success` 200-299 (A:core/TelemetryInterceptor.kt:55-79,99-117) | `http.{host,path}` templated + TLS/protocol detail (I:EdgeRumCapture/HTTPCapture.swift:341-359) | `http.url` templated + phase timings (F:capture/http_overrides.dart:1176-1226) | `http.{route,host}` templated, no `http.url` (R:adapters/httpAttributes.ts:88-120) | `http.url` templated, `success` 200-399 (C:src/network.ts:16-28,50-67) | **rename**. Ionic sends untemplated paths. The processor templates at ingest (P:extract.go:292), so this is not data loss. It is still a privacy and parity delta |
| C6 | XHR capture | — (`fetch` patch only; X:core/src/instrumentation/requests.ts) | n/a (OkHttp) | n/a (URLSession) | n/a | XHR (native), fetch+XHR (web) (R:adapters/xhrIntercept.ts:141) | fetch + XHR (C:src/network.ts:71-141) | **missing** |
| C7 | `traceparent` injection + `traceparent.outcome` | — (no trace code; grep of X:*/src) | yes, allowlist-gated (A:core/TelemetryInterceptor.kt:31-38; A:core/trace/TraceManager.kt:283-347) | — (spec only) | yes, allowlist empty by default (F:capture/trace_injection.dart:17,42-59) | yes, `traceHostAllowlist` (R:adapters/traceHeader.ts:6-24) | yes, `correlateRequestsTo` exact host (C:src/network.ts:42-47,82-90) | **missing** |
| C9 | Resource timing | M:`resource_timing` · `metric.{unit,resource_name,resource_type,screen,transfer_size}`; `resource_name` is the **raw URL, not sanitized** (X:core/src/instrumentation/perf-observer.ts:66-84) | — | M:`resource_timing` · `resource.{host,dns_ms,connect_ms,tls_ms,ttfb_ms,…}` (I:EdgeRumCapture/HTTPCapture.swift:361-379) | canon, never emitted | — retired (R:core/telemetry.ts:155-161) | M:`resource_timing` · `resource.{url (scrubbed),initiator_type}`, off by default (C:src/network.ts:144-159) | **rename** (`metric.*` vs `resource.*`; unsanitized URL) |
| C38 | Network change | `network_change` · `network.{connected,type,previous_type}` (X:capacitor/src/NetworkCapture.ts:186-218) | — (A:core/NetworkCapabilityDetector.kt:113) | `network_change` · `network.{type,effectiveType,expensive,constrained}` (I:EdgeRumCapture/NetworkPathCapture.swift:158-164) | `network_change` · `network.{previous_type,current_type,…}` (F:capture/network_capture_hook.dart:79-89) | `network_change` · `network.{type,previous_type}` (R:adapters/networkChange.ts:19-21) | `network_change` · `network.{type,previous_type}` (C native Signals.java:66-70) | **parity** |

### 1c. Traces

| # | Concept | Ionic 4.0.0 | Android | iOS | Flutter | RN 5.0 | Cordova | Tag |
|---|---|---|---|---|---|---|---|---|
| C8 | Trace/span model on events | — | `trace.id, span.id, parent.span.id, rum.action.id, trace.root_type ∈ launch\|interaction\|navigation\|request, span.start_time, span.duration_ms` on `app.start`, `ui.interaction`, `navigation`, `http.request`. Annotation only on `app.crash`/`app.hang`. Roots: 2 s idle, 10 s cap (A:core/trace/TraceManager.kt:109-110,171-271,356-408) | — (I:EdgeRumOTelBridge/Bridge.swift:1-17) | same keys on `http.request`, `ui.interaction`, `screen.load`, `task.complete` (F:managers/trace_manager.dart:79-85,185-187) | same keys + root `custom`. Tier 1: `app.start`, `view`, `http.request`, `ui.interaction`, `task.complete`. Tier 2: ids only on errors and `custom_event` (R:adapters/traceManager.ts:32,206-209,350-362) | `trace.id`/`span.id` on `http.request` only (C:src/network.ts:45) | **missing**. Wire owner: `edge_telemetry_android/docs/specs/backend-wire-contract.md` §4.4 L302-314, §6 L559-608. Processor columns: P:extract.go:279-289 |

### 1d. Errors and crashes

| # | Concept | Ionic 4.0.0 | Android | iOS | Flutter | RN 5.0 | Cordova | Tag |
|---|---|---|---|---|---|---|---|---|
| C10 | JS / unhandled error | `app.crash` · flat `exception_type, message, stacktrace, is_fatal, handled, cause, error_context, runtime=webview, crash.breadcrumbs` · window `error`/`unhandledrejection` + Angular `ErrorHandler` (X:core/src/instrumentation/errors.ts:60; X:angular/src/ErrorCapture.ts) | n/a | n/a | `app.crash`, flat keys (F:core/edge_event.dart:243-279) | `app.crash` · `error.*` keys (R:adapters/web/crashHandler.web.ts:24,37) | `app.crash`, flat keys, `runtime:webview` (C:src/errors.ts:24-54) | **parity** (with Android/Flutter/Cordova keys and processor `extractError`, P:extract.go:327) |
| C11 | Handled / manual error | `app.crash` with `handled=true, cause=ManualCapture` (X:core/src/EdgeRum.ts:357-380) | `app.crash` with `handled=true` (A:core/services/CrashReportingService.kt:217-271) | `app.error` (I:EdgeRum/EdgeRum.swift:500-520) | `app.crash` with `is_fatal=false` | `app.error` (R:core/telemetry.ts:600-609) | `app.crash` with `handled=true` (C:src/index.ts:96-98) | **parity** (siblings split 3/2; Ionic is with the majority) |
| C12 | Framework route error | `app.crash` with `cause=NavigationError` (X:angular/src/RouterCapture.ts:160-171) | — | — | — | — | — | **Ionic-ahead** |
| C13 | Native crash | `app.crash` · `cause=NativeCrash, runtime=native, crash.{platform,id,captured_at,signal,thread,symbolication}` · JVM + NDK + PLCrashReporter, replayed by JS on next launch (X:capacitor/src/NativeCrashCapture.ts:135-155,240) | `app.crash` (JVM). NDK appears only as `app.exit reason=crash_native` (A:core/services/CrashReportingService.kt:79-118; A:core/exit/ApplicationExitHarvester.kt:52) | `app.crash` · `crash.*` from PLCrash (I:EdgeRumCrash/CrashReportEncoder.swift:75-129) | `app.crash` (ApplicationExitInfo / MetricKit) (FA:104-118; FI:162-177) | — | `app.crash` (JVM/NDK/signal) (C native Crash.java:110-119; Crash.swift:173) | **parity** for the wire. R14 delta is in §2 |
| C14 | ANR | `app.crash` with `cause=ANR`, `anr.duration_ms` (X:capacitor/android/src/main/java/com/nathanclaire/rum/AnrWatchdog.kt) | `app.anr` (A:core/services/CrashReportingService.kt:146-163) | n/a | `app.crash` with `cause=ANR` (FA:158-159) | — | `app.anr` (C native Crash.java:137-149) | **rename** → `app.anr` (processor routes it, P:service.go:695) |
| C15 | Hang | `app.crash` with `cause=Hang`, iOS only, 5 s (X:capacitor/ios/Plugin/HangDetector.swift) | `app.hang` ≥2 s (A:core/services/CrashReportingService.kt:179-193) | `app.hang` · `hang.*` (I:EdgeRumCrash/HangEventEncoder.swift:63-83) | `app.crash` with `cause=Hang` (FI:180-188) | `app.hang`, JS-thread stall (R:adapters/hangDetector.ts:10-23) | `app.hang` 2 s, Android + iOS (C native Crash.swift:70-79) | **rename** → `app.hang`. Ionic also has no Android or JS-thread hang |
| C16 | Process exit reasons | — | `app.exit` · `exit.*` (A:core/exit/ApplicationExitHarvester.kt:50-90) | — | feeds `app.crash` | — | `app.exit` (C native Exits.java:65) | **missing** |
| C17 | WebView render-process death | — (grep: no `onRenderProcessGone` / `webViewWebContentProcessDidTerminate` in X:capacitor) | n/a | n/a | n/a | n/a | `app.crash` with `cause=WebViewTerminated`, `webview.{reason,detected_by}` (C native Crash.java:126-134; Crash.swift:84-100) | **missing** (highest-value WebView-specific gap) |
| C40 | Breadcrumbs | `crash.breadcrumbs` JSON string (ADR-024) | `crash.breadcrumbs` | `breadcrumbs` | `crash.breadcrumbs` | `error.breadcrumbs` | `crash.breadcrumbs` | **parity** |
| C41 | `console.error` | breadcrumb only (ADR-029; X:core/src/EdgeRum.ts:175-182) | — | — | — | `app.error`, opt-in, off by default | `app.crash` handled, if `captureConsoleErrors` | **parity** (deliberate; siblings split) |

### 1e. User interaction

| # | Concept | Ionic 4.0.0 | Android | iOS | Flutter | RN 5.0 | Cordova | Tag |
|---|---|---|---|---|---|---|---|---|
| C18 | Tap / click | `user.interaction` · `interaction.{type=click,screen,timestamp,target_tag,target_id,target_class,target_role}` (X:core/src/instrumentation/interactions.ts:25-80) | `ui.interaction` · `ui.{type,target,name_source,x,y,direction,screen}` (A:core/interaction/UserInteractionTracker.kt:64-111) | `user.interaction` · `interaction.*` (I:EdgeRumCapture/InteractionCapture.swift:186-211) | `ui.interaction` (F:capture/action_capture_hook.dart:206-232) | `ui.interaction` (R:adapters/uiInteraction.ts:187-215) | `ui.interaction` · `ui.{type,target,name_source,x,y,screen,rage,dead}` (C:src/interactions.ts:56-89) | **rename** → `ui.interaction`/`ui.*`. The processor child table reads only `ui.*` (P:service.go:707; P:extract.go:362-370). Android contract L525 retires `user.interaction` |
| C19 | Rage / dead clicks | — | — | — | — | `ui.rage`, `ui.dead` (web) (R:adapters/web/interactionWeb.web.ts:61,124) | `ui.rage` (3 in 1 s), `ui.dead` (C:src/interactions.ts:56-89) | **missing** |

### 1f. Performance

| # | Concept | Ionic 4.0.0 | Android | iOS | Flutter | RN 5.0 | Cordova | Tag |
|---|---|---|---|---|---|---|---|---|
| C20 | Web Vitals | M:`LCP\|INP\|CLS\|FCP\|TTFB` · `metric.{unit,rating,screen}` (X:core/src/instrumentation/vitals.ts:6-31) | n/a | n/a | n/a | same names · `vital.{rating,navigation_type,target,load_state}`, `lcp.*`, `inp.*` (web) (R:adapters/webVitals.ts:67-96) | same names · `metric.{unit,rating}`, **`screen.name`** (C:src/perf.ts:39-54; commit `86a8ca2`) | **rename** (`metric.screen` → `screen.name`; RN attribution keys absent) |
| C21 | Long task | M:`long_task` · `metric.{unit,name,screen}` (X:core/src/instrumentation/perf-observer.ts:49-52) | — | M:`long_task` (I:EdgeRumCapture/RunLoopObserverCapture.swift:101-128) | M:`long_task`, frozen frame >700 ms (F:capture/frame_capture_hook.dart:302-317) | — retired | count only, `frame.long_task_count` (C:src/perf.ts:80-84) | **parity** |
| C22 | Frames | M:`frame_render_time`, value = p95, **dotless** `frames_total, slow_frames, p95_ms, …`, `metric.screen`; WebView rAF + native Choreographer/CADisplayLink (X:core/src/instrumentation/frames.ts:102-111; X:capacitor/src/PerfSamplerCapture.ts:121) | E:`frame.summary` · `frame.{total_frames,slow_frames,frozen_frames,slow_frame_rate,…}` (A:core/TelemetryFrameDropCollector.kt:122-157) | M:`frame_render_time`, value = max, `frame.*` (I:EdgeRumCapture/FrameSampler.swift:223-256) | E:`frame.summary` (F:capture/frame_capture_hook.dart:251-296) | M:`frame_render_time`, value = p95, `frame.*` (R:adapters/frameAggregate.ts:50-66) | E:`frame.summary` · `frame.*`, `frame.source:raf` (C:src/perf.ts:187-204) | **rename** → `frame.summary`/`frame.*` (processor child table, P:service.go:745,822) |
| C23 | Memory | M:`memory_usage` MB · **dotless** `unit, memory_type, memory_source, memory_pressure_level` (X:core/src/instrumentation/memory-web.ts:60-64; X:capacitor/src/PerfSamplerCapture.ts:138) | M:`memory_usage` · `memory.*` (A:core/MemoryTracker.kt:306-335) | M:`memory_usage` · `memory.*_kb` (I:EdgeRumCapture/MemorySampler.swift:106-123) | M:`memory_usage` bytes (F:capture/memory_bookend_hook.dart:76-116) | M:`memory_usage` · `memory.*` (R:adapters/native/memoryNative.native.ts:35-43) | M:`memory_usage` · `memory.*` (C native Signals.java:22-50) | **rename** (dotless → `memory.*`) |
| C24 | Memory pressure | attribute `memory_pressure_level` on the metric | E:`memory_pressure` (A:core/MemoryTracker.kt:97-112) | `memory.pressure` attribute | — | — | E:`memory_pressure` (C native Signals.java; Signals.swift:15-34) | **rename** → E:`memory_pressure` (processor perf table, P:service.go:823) |
| C25 | Storage | — | E:`storage_usage` (A:core/MemoryTracker.kt:132-148) | — | — | — | — | **missing** (Android only) |
| C26 | CPU | — | — | M:`cpu_usage` (I:EdgeRumCapture/MemorySampler.swift:274) | — | — | — | **missing** (iOS only) |
| C39 | Bridge timing | — | n/a | n/a | n/a | n/a | E:`bridge.summary`, `bridge.call` (C:src/perf.ts:88-147,205-217) | **missing** (Capacitor-bridge analogue) |

### 1g. Device, session and lifecycle

| # | Concept | Ionic 4.0.0 | Android | iOS | Flutter | RN 5.0 | Cordova | Tag |
|---|---|---|---|---|---|---|---|---|
| C27 | Battery / device state | context `device.batteryLevel`, `device.batteryCharging` (camelCase) (X:capacitor/src/DeviceContext.ts:210-221) | `device.{battery_level,battery_charging,power_save,thermal_status,orientation}` on fatal events (A:core/device/DeviceStateSnapshot.kt:36-59) | `device.{thermal_state,low_power_mode,orientation}` context (I:EdgeRumCore/Context/PowerContext.swift:13,56) | on JVM crash (FA:118,207-218) | battery on crash/hang | — | **rename** (camelCase → snake_case; no thermal/power-save) |
| C28 | Session start | `session.started` · `session.start_reason ∈ init\|rotation_timeout\|resumed` (X:core/src/EdgeRum.ts:170; X:capacitor/src/LifecycleCapture.ts:244-246) | `session.started` · `session.{is_first_session,total_sessions}` | `session.started` · `session.rotation`, `previous_session.*` | `session.started` | `session.started` · `session.reason` | `session.started` | **parity** (reason key differs per SDK; processor ignores it) |
| C29 | Session end | `session.finalized` · `session.{duration_ms,ended_at,end_reason}` + `sdk.{error_count,dropped_count,disposed_captures}` + journey. Finalizes on **every** background (X:capacitor/src/LifecycleCapture.ts:213-222) | `session.finalized` · `session.reason ∈ timeout\|manual`, exactly once (#143) (A:core/TelemetryManager.kt:512-537) | `session.finalized` (I:EdgeRumCore/Recorder.swift:807,823-829) | `session.finalized` + counts (F:managers/session_manager.dart:436-458) | `session.finalized` | `session.finalized` | **parity** for the name. Semantics: the processor recomputes session span from events and ignores SDK session attrs (commit `fef0ebc`) |
| C35 | App lifecycle | `app_lifecycle` · `lifecycle.event ∈ foreground\|background` (X:capacitor/src/LifecycleCapture.ts:253,262) | — | `app_lifecycle` · `lifecycle.{state,previous_state}` (I:EdgeRumCapture/LifecycleCapture.swift:99-125) | `app_lifecycle` · `lifecycle.state` | `app_lifecycle` · `app_lifecycle.state` | `app_lifecycle` · `lifecycle.state` (C native Signals.java:17-18) | **rename** (`lifecycle.event` → `lifecycle.state`) |
| C36 | App start (cold start) | attribute `lifecycle.cold_start_ms` on the first `app_lifecycle`. JS module-load → first foreground, **excludes native and WebView boot** (X:capacitor/src/LifecycleCapture.ts:250) | `app.start` · `app.start.{type,duration_ms}` + launch root (A:core/TelemetryManager.kt:434-446) | `page_load` (I:EdgeRumCapture/PageLoadCapture.swift:221-275) + M:`launch_interactive` | `page_load` · `startup.*` (F:capture/perf_capture_hook.dart:42-56) | `app.start` (R:core/telemetry.ts:847-855) | `app.start` · `app.start.{type,duration_ms,webview_created_ms,response_end_ms,dom_content_loaded_ms,load_ms,deviceready_ms,mark_ready_ms}`, built natively (C:src/perf.ts:19-35; C native Launch.java:21-69) | **missing** (`app.start` event) |
| C37 | WebView page load (Navigation Timing) | `page_load` · `page.{ttfb_ms,dom_content_loaded_ms,load_duration_ms,resource_count,route}` (X:core/src/instrumentation/pageload.ts:34-38,72) | — | `page_load` means **native cold start** | `page_load` means **cold start** | retired | banned; folded into `app.start` phases (C:docs/spec.md:123) | **rename**. Same name, different meaning on iOS/Flutter. Cordova's model: fold into `app.start.*` phases |

### 1h. Identity, custom data and SDK health

| # | Concept | Ionic 4.0.0 | Android | iOS | Flutter | RN 5.0 | Cordova | Tag |
|---|---|---|---|---|---|---|---|---|
| C30 | SDK health | `sdk.{error_count,dropped_count,disposed_captures}` on `session.finalized` | E:`telemetry.capabilities_initialized` (A:core/TelemetryManager.kt:874-895) | E:`sdk.health` per batch, unprefixed (I:EdgeRumCore/SdkHealth.swift:25-57) | counters on `session.finalized` | `sdk.*` on every row (R:core/telemetry.ts:1566-1577) | E:`sdk.health` at send time (C ios Sender.swift:123-124,179-184) | **rename** (R4 makes `sdk.health` the shared shape; optional for non-iOS) |
| C31 | Identify | `user.profile.update` · `user.{name,email,phone,profile_version,profile_updated_at}` (X:core/src/EdgeRum.ts:286-302) | same name (A:core/TelemetryManager.kt:990-1018) | same (I:EdgeRumCore/Recorder.swift:581-592) | same (F:facade/edge_telemetry.dart:663-725) | same (R:core/telemetry.ts:1245) | same (C:src/index.ts:52-58) | **parity** |
| C32 | Custom event | `custom_event` + `event.name` (X:core/src/EdgeRum.ts:306-312) | raw name (A:core/TelemetryManager.kt:629-672) | `custom_event` | `custom_event` | `custom_event` | `custom_event` | **parity** |
| C33 | Custom metric / timer | `time().end()` → M:`<name>`, `metric.unit=ms` (X:core/src/EdgeRum.ts:341-354) | `recordMetric(any)`; no timer | M:`custom_timer` + `timer.name` | `trackMetric` dropped unless canon | `recordMetric(any)` | `measure()`, `time()` → host name | **parity** |
| C34 | Tasks / actions | — | — | `action.started`/`action.ended` (I:EdgeRum/RumAction.swift:63,105) | `task.complete` (F:core/edge_event.dart:191-219) | `task.complete` (R:core/telemetry.ts:1124-1132) | `task.complete` (C:src/index.ts:102-134) | **missing** (`task.complete` is the 3-of-5 shape) |

### 1i. Ionic-only

| # | Concept | Ionic 4.0.0 | Siblings | Tag |
|---|---|---|---|---|
| C42 | Capture circuit breaker | HealthMonitor disposes a throwing capture; `sdk.disposed_captures` (ADR-031; X:core/src/internal/health.ts) | none found (unverified beyond grep of agent reports) | **Ionic-ahead** |
| C43 | Browser (`web`) platform | runs with `device.platform=web` (X:capacitor/src/DeviceContext.ts:1,237,284) | Flutter and Cordova disable on non-mobile (F:managers/identity_format.dart:87-94; C:src/core.ts:86-87). RN web is legacy-envelope | **Ionic-ahead**, but conflicts with R16 |
| C44 | Journey summary on session end | `session.{visited_screens,screen_count,event_count,metric_count,journey_truncated}` (X:core/src/session/SessionManager.ts:216-220) | Flutter `session.screen_journey` (F:managers/session_manager.dart:436-458) | **Ionic-ahead** (partial: Flutter has it). The processor ignores SDK session attrs, so its value is low |

Capture tally: parity 14 (C1, C2, C10, C11, C13, C21, C28, C29, C31, C32, C33, C38, C40, C41) · rename 13 (C5, C9, C14, C15, C18, C20, C22, C23, C24, C27, C30, C35, C37) · missing 13 (C3, C4, C6, C7, C8, C16, C17, C19, C25, C26, C34, C36, C39) · Ionic-ahead 4 (C12, C42, C43, C44).

---

## 2. Contract 4, rule by rule

Normative text: W:assets/06-batch-header-draft.md:33-50 (the rules). Gist: W:spec.md:110-127. S1: W:spec.md:129. The siblings' compliance is in the right-hand column for reference (A/I/F/C = Android/iOS/Flutter/Cordova; RN 5.0 is legacy on every envelope rule, R:adapters/batch.ts:5-12).

| Rule | Requires (cite) | Ionic 4.0.0 does | Delta | Siblings | Tag |
|---|---|---|---|---|---|
| R1 | Identity in the envelope only; `app` = package_name, platform, version, build_number (+ name) (06-draft:35) | `app.*`, `device.id`, `sdk.*` merged into every event's attributes (X:core/src/internal/context.ts:72-83; X:core/src/transport/PayloadBuilder.ts:28-54) | Move identity to envelope `app{}` and root `device_id`; strip from events | A/I/F/C comply (A:core/TelemetryHttpClient.kt:176-177; I:EdgeRumCore/PayloadBuilder.swift:21-30; F:core/wire_canon.dart:96) | **rename** |
| R2 | `sdk.name="ionic"`; `app.platform ∈ android\|ios`; drop `sdk.platform` (06-draft:36) | `sdk.platform="ionic-angular-capacitor"` per event (X:core/src/index.ts:3; context.ts:80) | Emit `sdk{name:"ionic",version}`; `app.platform` from `Device.getInfo()` | A/I/F/C comply | **rename** |
| R3 | Envelope closed at 8 keys (06-draft:37) | `{type,timestamp,location?,batch_size,events}`. No `contract_version`, `device_id`, `sdk` or `app` (X:core/src/transport/PayloadBuilder.ts:20-26,56-64) | Add 4 keys, remove `location` | A/I/F/C comply (A:core/models/TelemetryBatch.kt:7-31; I:EdgeRumCore/EventEnvelope.swift:80-89; F:core/wire_canon.dart:117-156; C ios Sender.swift:173-191) | **missing** |
| R4 | iOS health → `sdk.health` event; optional for others (06-draft:38) | health counters ride the `session.finalized` event, not the envelope | None required. Optional `sdk.health` would align with iOS/Cordova | I, C emit it | **parity** |
| R5 | Flutter `clock_skew_ms` dropped (06-draft:39) | never sent | none | — | **parity** |
| R6 | Flutter `context` → event attrs (06-draft:40) | n/a | none | — | **parity** |
| R7 | Envelope `location` dropped; geo from IP (06-draft:41, names Ionic) | sends `location` from config, plus opt-in `resolveLocation` third-party IP lookup (X:core/src/EdgeRum.ts:156,206-220; X:core/src/internal/locationResolver.ts) | Remove `location`, `resolveLocation`, `locationProviderUrl` (public API break) | A/I/F/C comply | **missing** |
| R8 | Environment never sent (06-draft:42) | `app.environment` on every event, default `production` (X:core/src/internal/context.ts:31) | Stop sending; deprecate `EdgeRumConfig.environment` | A/I/F/C comply | **missing** |
| R9 | Root `device_id`, required; UUIDv4 persisted fallback, else in-memory (06-draft:43) | per-event `device.id` = `device_<ms>_<hex16>_<platform>` in localStorage. On storage failure it generates per call (not pinned per process) (X:capacitor/src/DeviceContext.ts:172-190,274,293). A core-only install has no `device.id` (X:core/src/internal/pipeline.ts:193-209 backfills only when context loaded) | Move to root; guarantee presence; pin the fallback per process | A (UUID fallback, A:core/ids/IdGenerator.kt), I (Keychain), F (secure storage), C (UUID) | **rename** |
| R10 | POST to the configured URL as given (06-draft:44) | `fetch(this.endpoint)` verbatim (X:core/src/transport/RetryTransport.ts:66) | none | all comply | **parity** |
| R11 + S1 | `contract_version:"4.0.0"` at root; `sdk.version` = package version (06-draft:45; W:spec.md:129) | `sdk.contract_version:"3.1.0"` per event (X:core/src/index.ts:2); `sdk.version:"4.0.0"` per event | Root `contract_version:"4.0.0"` (or 4.x). The Ionic package is 4.0.0 but on contract 3.1.0, so the processor sees it as `legacy` (P9 alias `ionic-angular-capacitor`→ionic, W:spec.md:195) | A/I/F/C send "4.0.0" | **rename** |
| R12 | Retry 429/5xx/network then queue; drop other 4xx, never queue (06-draft:46) | retryable = {0, 429, 503} only. **500/502/504 are classed fatal and dropped** (X:core/src/transport/RetryTransport.ts:7,77-85; X:core/src/queue/OfflineQueue.ts:319-329). Other 4xx dropped (correct). The `sendBeacon` path on pagehide (non-iOS) sends **no `X-API-Key`** and cannot retry (X:capacitor/src/LifecycleCapture.ts:335-340) | Retry all 5xx. Fix beacon auth (e.g. `fetch keepalive` with headers, as RN web does, R:adapters/webSender.ts:44) | A/I/F/C comply (I maps all 5xx; C 3 retries + park) | **missing** |
| R13 | Envelope `timestamp` UTC `Z`, set at **send**; re-stamp queued batches (06-draft:47) | `toISOString()` (UTC `Z`, fine) at build time. But the queue stores the serialized body and replays it unchanged (X:core/src/internal/pipeline.ts:145-158; X:core/src/queue/OfflineQueue.ts:296-305) | Store events, not bodies, or re-stamp on drain | A/I/F/C re-stamp (A:core/TelemetryHttpClient.kt:146-148; I:…/HTTPTransportSink.swift:129,201-202; C ios Sender.swift:128,177) | **missing** |
| R14 | Replayed crash/hang in its own batch with the crashed build's `app.version`/`build_number`/`name` (06-draft:48) | native record has no app version/build (X:capacitor/src/NativeCrashCapture.ts:4-21). It is emitted via `recordEvent` into the normal buffer with the current context (:240) | Persist build at crash time natively; send solo batch | A/I/F/C comply (A:core/services/CrashReportingService.kt:116,161; I:EdgeRumCore/Recorder.swift:482-499; F:core/pipeline.dart:57-65; C native Outbox.java:101) | **missing** |
| R15 | Nil version/build omitted, never `""` (06-draft:49) | `app.version` set only if configured; `app.build_number` only if non-blank (X:core/src/internal/context.ts:26-30,34-37) | none (re-check once moved to the envelope) | all comply | **parity** |
| R16 | OS ∉ {android, ios} → disable, one warning, send nothing (06-draft:50) | runs on `web` and sends `device.platform=web`. `ios\|android\|web` is in the schema enum (docs/payload-schema.json:136) | Gate on `Capacitor.isNativePlatform()`. This is a product decision: Ionic `web` (dev/PWA) support would end | F, C comply; A/I native-only by nature | **missing** |

Contract tally: parity 5 (R4, R5, R6, R10, R15) · rename 4 (R1, R2, R9, R11) · missing 7 (R3, R7, R8, R12, R13, R14, R16).

Backend-readiness note: contract-4 batches need the U2 backend release (W:spec.md:221). The processor already has the `normalize` 4.x path (P:normalize.go:272 `sdk.health`). Legacy Ionic batches keep working forever (U1, W:spec.md:220).

---

## 3. Not verified

- **Sibling cells were gathered by parallel read-only sweeps of each sibling repo and then spot-checked.** Spot checks: Android traceparent (A:core/TelemetryInterceptor.kt:31-38), iOS has no trace code, RN 4-key envelope (R:adapters/batch.ts:5-12), Cordova `contractVersion = "4.0.0"` (C:ios/Sources/EdgeRum/Sender.swift:7), Flutter canon list (F:core/wire_canon.dart:32-40). The remaining sibling line numbers were not re-opened individually.
- **Cordova native cites are abbreviated.** `Crash.java`, `Signals.java`, `Launch.java`, `Exits.java`, `Outbox.java` and `Sender.java` are under `C:android/src/main/java/com/nathanclaire/rum/cordova/`; `*.swift` files are under `C:ios/Sources/EdgeRum/`. Cordova is pre-release and moving daily.
- **R16 on iOS SDK**: no explicit gate found (iOS-only build). Android: not checked.
- **Ionic's `CapacitorHttp` native transport** (X:capacitor/src/capacitor-http-fetch.ts) was not traced for status classification. If it wraps `fetch`, §2 R12 applies unchanged.
- **Whether HTTP from native Capacitor plugins (CapacitorHttp `patch` mode) is visible to the `fetch` patch**: unverified.
- **Ionic C42 "no sibling has a breaker"** rests on agent reports, not my own grep.
- **Collector-side behaviour** (stripping, `sendBeacon` 401) was not tested live; only code was read.
- **The RN v5 contract (`edge_telemetry_react_native/docs/backend-wire-contract.md`, 2454 lines)** was read only at §0–2 and §4.0. Its §6 trace rules and Appendix B sign-off asks (A1–A14) were taken from the agent summary.
- **Web-vitals support per WebView** (WKWebView vs Android System WebView) was not tested.

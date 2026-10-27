# Ionic / Capacitor / Angular competitor SDKs: what they ship, what to borrow, what to skip

Ticket #73 (wayfinder map #68). Research only. As of 2026-10-27, Ionic HEAD `351f8e2`.

This doc builds on the Cordova sibling `../edge_telemetry_cordova_sdk/docs/research/cordova-competitor-sdks.md`, cited as `cordova §x`. It does not repeat that work. It adds only what changes for Capacitor, Ionic and Angular. Companions: `ionic-platform-capabilities.md` (#72, "caps §x"), `trace-v3-for-webview.md` (#70, "trace-v3"), `lightweight-baseline.md` (#71, "baseline"), `ionic-gap-inventory.md` (#69, "gap").

## Summary

- **Only Sentry and New Relic ship a real Capacitor plugin.**
  - Dynatrace reuses its Cordova plugin through a `capacitor:sync:after` hook.
  - Firebase (Capawesome) is native-only, driven by manual JS calls.
  - Datadog, Raygun, Bugsnag and Embrace are browser JS only. Datadog's own guide says native code and native crashes are **not monitored**.
  - None of them has an npm Capacitor package (all 404).
- **Nobody instruments the Capacitor bridge, the Ionic lifecycle or WebView death.** A grep of every readable competitor source finds zero hits for `nativePromise`, `ionViewDidEnter`, `ionBackButton`, `onRenderProcessGone` or `WebContentProcess`.
  - That confirms caps §Summary: plugin-call timing, Ionic page and overlay capture, and renderer death are open ground.
  - Closed native agents (Dynatrace, NR) are **unknown**.
- **Tracing.** Auto route spans come only from the Angular-aware SDKs: Sentry `TraceService` and Bugsnag `AngularRoutingProvider`.
  - Both name the route from `ActivatedRouteSnapshot.routeConfig.path`, which edge-rum already does.
  - Both end the navigation late: Sentry with an idle span (1 s idle, 30 s cap), Bugsnag with "settle". Datadog does the same with page activity and a 100 ms quiet period.
  - Every SDK patches fetch and XHR.
  - **No one auto-spans plugin calls or a JS-anchored app start.** Firebase's iOS `_app_start` ends at `didBecomeActive`, before the WebView has rendered anything.
- **Propagation defaults split three ways, and they matter more in a WebView:**
  - Sentry: same-origin only. In Capacitor the origin is `capacitor://localhost` or `https://localhost`, so this means **inject nowhere**.
  - Datadog: nothing until `allowedTracingUrls` is set. Bugsnag: `propagateTraceContext: false`.
  - New Relic Capacitor: **every** fetch gets `traceparent`/`tracestate`/`newrelic` with no allowlist, which trips CORS (trace-v3, caps §1.3). XHR gets nothing.
  - This confirms trace-v3's "empty allowlist = inject nowhere".
- **Size.** Measured the same way as baseline (esbuild 0.28.2 `--minify`, `gzip -9`, minimal `init`):
  - Datadog RUM: ~66 KB eager.
  - Embrace: 58 KB.
  - Sentry Capacitor + tracing: 53 KB.
  - Raygun: 25 KB.
  - Bugsnag: errors 16 KB, performance 13.5 KB.
  - NR JS layer: 2.7 KB, with a large native agent.
  - edge-rum's ~21 KB full stack is already the lightest full-featured option. Size is not where to compete.
- **Biggest new finding: zone pollution.**
  - Sentry wraps every timer and span in `Zone.root.run`. Datadog bans zone-patched `setTimeout`, `addEventListener` and `MutationObserver` with a lint rule and reads the `__zone_symbol__` originals.
  - edge-rum does neither. `EdgeRum.init()` runs from `APP_INITIALIZER`, which Angular executes inside `ngZone.run`. So the default-on rAF frame loop and the 5 s flush interval are zone tasks, and in zone-based apps each one probably triggers app-wide change detection.
  - Baseline's "~10 µs/frame" was measured on a blank page with no zone, so in an Angular app the cost is **understated**. Not yet measured on a device.
- **Top borrows (value ÷ cost):**
  1. Escape the zone.
  2. Opt-in `traceparent` allowlist, header only.
  3. Rewrite stack frames from `WEBVIEW_SERVER_URL` to `app://`.
  4. Build-time release / OTA bundle id plus source-map upload key. Sentry gets this **wrong** for OTA (it uses the native release).
  5. Session-deterministic trace sampling.
- **Top skips:**
  - Session replay.
  - Sentry's base64-envelope-over-bridge transport.
  - NR's console patch at import, per-request bridge round-trips and response-body capture.
  - Dynatrace build-time agent injection and cookie proxies.
  - Embrace/OTel-sized stacks.
  - Vendor headers (`sentry-trace`, `baggage`, `x-datadog-*`, `newrelic`).
  - DOM-wide `MutationObserver` "settle" detection.

## Method and citation legend

npm tarballs were read as data in the session scratchpad and never run. Line numbers are from these snapshots. Sizes were measured with throwaway entry files that call each vendor's documented minimal init (`init({dsn})`, `datadogRum.init(...)`, `BugsnagPerformance.start(...)`, etc.). `@capacitor/core` and `@angular/*` were left external. For lazy chunks, `--splitting` was used and each chunk measured. The numbers are comparable to baseline's esbuild rows, not to `size-limit`.

| Prefix | Expands to | Version |
|---|---|---|
| `SCap:` | npm `@sentry/capacitor@4.4.0` `package/` (git tag `4.4.0` = `f9faf34`) | latest, 2026-09-18 |
| `SAng:` | npm `@sentry/angular@11.9.0` `package/fesm2020/sentry-angular.mjs`. The same logic was checked in `10.69.0` (the version SCap pins), `fesm2015` | latest |
| `SJS:` | https://github.com/getsentry/sentry-javascript/blob/10.69.0/ | tag pinned by SCap |
| `DD:` | https://github.com/DataDog/browser-sdk/blob/v7.16.2/packages/ | latest |
| `NRC:` | npm `@newrelic/newrelic-capacitor-plugin@1.6.14` `package/` | latest, 2026-10-23 |
| `NRG:` | https://github.com/newrelic/newrelic-capacitor-plugin/blob/b8fd5444bd/ | main 2026-10-26 |
| `DT:` | npm `@dynatrace/cordova-plugin@2.349.1` `package/` (same tarball as cordova §2.3) | latest |
| `FBP:` / `FBC:` | npm `@capacitor-firebase/performance@8.5.2` / `@capacitor-firebase/crashlytics@8.5.2` `package/` | latest |
| `BGP:` / `BGA:` | npm `@bugsnag/browser-performance@3.4.1` / `@bugsnag/angular-performance@3.0.0` `package/dist/` | latest |
| `EMB:` | npm `@embrace-io/web-sdk@2.31.0` `package/` | latest |
| `CAP:` | https://github.com/ionic-team/capacitor/blob/d19f1ea/ (same pin as caps) | 8.5.3 |
| `NG:` | Repo `node_modules` `@angular/core@18.2.14` `fesm2022/core.mjs` | in-repo |
| `X:` | `packages/` in this repo at `351f8e2` | |

---

## 1. Matrix (Capacitor / Ionic / Angular deltas vs cordova §1)

| SDK | Capacitor package | JS layer | Auto route spans | HTTP capture | `traceparent` default | Native crash / ANR / hang | Plugin-call / WebView death | OTA release identity | Size (gzip, measured) |
|---|---|---|---|---|---|---|---|---|---|
| **Sentry** `@sentry/capacitor` + `@sentry/angular` | Yes (4.4.0). Peer-pins siblings **exactly** (`@sentry/angular: 10.69.0`) while latest is 11.9.0. A `postinstall` checks the pin (SCap:package.json:26,44-47,61-63) | `@sentry/browser` 10.69.0 + sentry-cocoa / sentry-android | Yes, via `TraceService` (Angular router) | fetch + XHR spans (`traceFetch`/`traceXHR` default true, SJS:packages/browser/src/tracing/request.ts:131-133) | Same-origin only = **nowhere** in Capacitor (request.ts:314-316). Sends `sentry-trace` + `baggage`; `traceparent` only with `propagateTraceparent: true` (default false, SJS:packages/core/src/types/options.ts:524-536) | Yes: JVM/NDK/ANR, iOS hang, **watchdog termination on by default** (SCap:dist/esm/sdk.js:22-27) | No | **No.** Release = native `id@version+build` (SCap:dist/esm/integrations/release.js:24-33) | 53.4 KB (Cap + tracing, no Angular); `@sentry/browser` init only 28.1 KB |
| **Datadog** browser RUM | **None.** The Capacitor guide is browser-SDK only: "native part … is not monitored", and native crashes are not sent ([guide](https://docs.datadoghq.com/real_user_monitoring/guide/monitor-capacitor-applications-using-browser-sdk)) | `@datadog/browser-rum` 7.16.2 | Views (URL-based; no Angular integration) | fetch + XHR | Nothing until `allowedTracingUrls` is set. Default propagators `tracecontext` + `datadog` ([docs](https://docs.datadoghq.com/real_user_monitoring/correlate_with_other_telemetry/apm/?tab=browserrum)) | No (in Capacitor) | No | n/a | ~66.4 KB eager + 15.7 KB lazy (recorder 12.3, profiler 3.4); `-slim` 54.4 KB |
| **New Relic** `@newrelic/newrelic-capacitor-plugin` | Yes (1.6.14) | 2.7 KB JS patch layer + native agents | No | fetch + XHR patches → `noticeHttpTransaction`; CapacitorHttp via native agent (NRC:README.md:13) | **Every fetch**, no allowlist (NRC:dist/esm/index.js:133-160). **XHR never** (:187-246) | Yes (native agents) | No | **unknown** | 2.7 KB JS (native agent not measured) |
| **Dynatrace** `@dynatrace/cordova-plugin` | Reused Cordova plugin, Capacitor 6+, via `ionic:capacitor:build:before` / `capacitor:sync:after` script (DT:README.md:23,157-201) | Closed RUM JS injected at build + OneAgent | **unknown** (closed RUM JS) | RUM JS auto (cordova §2.3) | **unknown** | Yes (OneAgent) | **unknown** | **unknown** | Capacitor iOS app **+4.2 MB**, Android +0.1 MB (DT:README.md:958-959) |
| **Firebase** `@capacitor-firebase/*` | Yes (Capawesome 8.5.2, community) | Thin `Promise` wrappers; every call is a bridge round-trip (FBP:dist/esm/definitions.d.ts:7-76) | No | Native only (WebView traffic likely not, cordova §2.5) | n/a | Crashlytics native. JS = manual `recordException` + stacktrace.js frames (FBC:README.md:16,203-207,607) | No | No | ~0.3 KB JS |
| **Bugsnag** `@bugsnag/browser-performance` + `@bugsnag/angular-performance` | None (cordova §2.7) | Browser only | Yes: `AngularRoutingProvider`, ended on settle (BGA:index.js:15-62) | fetch + XHR trackers | `propagateTraceContext: false` per request via `networkRequestCallback`; `traceparent` only (BGP:auto-instrumentation/network-request-plugin.js:18-33,91) | No | No | n/a | perf 13.5 KB + errors 16.3 KB |
| **Raygun** `raygun4js` | None. The Ionic page points to Raygun4JS ([raygun docs](https://raygun.com/documentation/language-guides/javascript/crash-reporting/ionic/)) | Browser only (cordova §2.6) | SPA timings, URL-based | fetch + XHR | **unknown** / none found | No | No | n/a | 24.7 KB |
| **Embrace** `@embrace-io/web-sdk` | None (no Capacitor/Ionic/Cordova repo in the `embrace-io` org) | OTel web stack (`@opentelemetry/*` deps, EMB:package.json) | No Angular integration (exports only `.` and `./react-instrumentation`) | OTel fetch + XHR instrumentations | OTel defaults (**unverified** for this SDK) | No | No | n/a | 58.3 KB |
| **edge-rum 4.x** (reference) | Yes | core + angular + capacitor | `navigation` event only. No spans yet (gap C7/C8) | fetch + XHR (#85) | None (no trace code yet, trace-v3) | Yes (PLCrash, JVM, NDK, ANR, hang) | No (caps §1, §4.1) | No (caps §4.3) | ~21 KB full stack (baseline) |

---

## 2. Per-SDK deltas

### 2.1 Sentry `@sentry/capacitor` + `@sentry/angular`

Cordova §2.1 still holds for scope sync, native ANR/NDK and source-map tooling. What is new in Capacitor:

- **Wrapper over a sibling SDK.**
  - `init(options, originalInit)` forwards to `@sentry/angular`'s `init` (SCap:dist/esm/sdk.js:17,78).
  - Defaults: `enableAutoSessionTracking`, `enableWatchdogTerminationTracking: true`, `enableCaptureFailedRequests: false` (sdk.js:22-27).
  - Native is disabled on `platform === 'web'` (sdk.js:29-32).
  - Docs: Angular ≥ 14 only ([Sentry Capacitor guide](https://docs.sentry.io/platforms/javascript/guides/capacitor/)).
- **Transport.**
  - Native transport with a 30-slot promise buffer (SCap:dist/esm/transports/native.js:3-16).
  - Each envelope is serialised to bytes, **base64-encoded** and passed through `captureEnvelope` (SCap:dist/esm/wrapper.js:17,58), then on to `InternalSentrySdk.captureEnvelope` (SCap:android/src/main/java/io/sentry/capacitor/SentryCapacitor.java:259-270).
  - This is the same pattern as cordova §2.1. It inflates every payload by about 33% and runs a bridge round-trip per envelope.
- **Default integrations.**
  - Capacitor-specific: rewrite frames, native release, event origin, SDK info, native device context (SCap:dist/esm/integrations/default.js:12-34).
  - Plus the standard browser set.
  - No tracing by default. `browserTracingIntegration` comes from the sibling.
- **Stack frame rewrite** (SCap:dist/esm/integrations/rewriteframes.js:20-50):
  - Strips `window.WEBVIEW_SERVER_URL`, or falls back to `https?://localhost(:port)` / `capacitor://localhost`.
  - Strips `ng://`.
  - Prefixes `app://`.
  - Marks `[native code]` as not in-app.
  - Capacitor itself injects `WEBVIEW_SERVER_URL` on both platforms (CAP:ios/Capacitor/Capacitor/JSExport.swift:19; CAP:android/capacitor/src/main/java/com/getcapacitor/Bridge.java:1031).
  - This is the Capacitor form of cordova §4 #3.
- **Scope sync.** `setUser`, `setTag(s)`, `setExtra(s)`, `addBreadcrumb` and `setContext` are each monkey-patched to also call native (SCap:dist/esm/scopeSync.js:18-62). That is one bridge call per breadcrumb.
- **Release.** If the app doesn't set `release`, it becomes the native `id@version+build` (SCap:dist/esm/integrations/release.js:24-33).
  - A Capgo or Appflow OTA bundle therefore reports the **binary's** release, and source maps resolve against the wrong upload.
  - No Capgo/live-update handling in the repo (GitHub code search `capgo` in getsentry/sentry-capacitor returns 0).
  - Confirms caps §4.3.
- **Angular router capture (`TraceService`)** (SAng:274-359):
  - `NavigationStart` starts a navigation root span (named after the URL) plus a child `ui.angular.routing` span.
  - `ResolveEnd` renames the root to the parameterised route from `routeConfig.path` (SAng:337-345, 577-591).
  - `NavigationEnd/Cancel/Error` ends the routing span (SAng:346-354).
  - The root is an **idle span**: 1 s idle timeout, 30 s final timeout, 15 s child timeout (SJS:packages/core/src/tracing/idleSpan.ts:24-27). Its end therefore includes the follow-on requests.
  - Defaults also turn on long task, long animation frame and INP collection (SJS:packages/browser/src/tracing/browserTracingIntegration.ts:335-348).
- **Component spans.** `TraceDirective` / `@TraceClass` / `@TraceMethod` time `ngOnInit → ngAfterViewInit` (`ui.angular.init`), opt-in per component (SAng:413-551).
- **Zone handling.** Every span start and end runs inside `runOutsideAngular`, which is `Zone.root.run(cb)` when zone.js is present (SAng:91-98). The stated reason is that background SDK work otherwise delays Angular's stability (SSR, hydration).
- **App start.** No JS app-start span exists in SCap (grep: no `appStart`). iOS passes `enableAutoPerformanceTracing` to sentry-cocoa (SCap:ios/Sources/SentryCapacitorPlugin/SentryCapacitorPlugin.swift:161-162). Whether cocoa emits an app-start measurement in a Capacitor app is **unknown**.
- **Size.** Sentry's own CI ceilings: browser init 33 KB, with tracing 52 KB, with tracing + replay 91 KB (SJS:.size-limit.js:7-11,39-43,67). These are budgets, not measurements. Measured: 28.1 / 47.3 KB, and 53.4 KB with the Capacitor layer.

### 2.2 Datadog (browser RUM inside the WebView)

- **Capacitor support is the browser SDK only.**
  - The guide uses `sessionPersistence: "local-storage"` because cookies are unreliable on `capacitor://`.
  - It warns that `capacitor://` local pages and `https://` remote pages become two sessions.
  - Native code and native crashes are explicitly not monitored ([guide](https://docs.datadoghq.com/real_user_monitoring/guide/monitor-capacitor-applications-using-browser-sdk)).
- **Hybrid bridge exists but not for Capacitor.**
  - The native SDKs' `WebViewTracking.enable(webView, hosts)` injects `window.DatadogEventBridge`.
  - The browser SDK then sends every event through `bridge.send(JSON.stringify(...))` instead of HTTP, when the page host matches `getAllowedWebViewHosts()` (DD:browser-core/src/transport/eventBridge.ts:9-14,42-44,54-56; [iOS WebView tracking](https://docs.datadoghq.com/real_user_monitoring/ios/web_view_tracking/)).
  - No Capacitor plugin wires this up (**unverified** that nobody does it in community code).
- **Propagation.**
  - The allowlist entry can be a string, RegExp or function, optionally `{match, propagatorTypes}`. No match means no header (DD:browser-rum-core/src/domain/tracing/tracer.ts:132-137).
  - The sampling decision is **deterministic per session id** (`isSampled(session.id, …)`), and the bridge can override it (tracer.ts:139-145).
  - `traceparent` carries a 64-bit id zero-padded to 128 bits (`00-0000000000000000{64}`), plus `tracestate: dd=s:…;o:rum` (tracer.ts:200-203).
  - `traceContextInjection` defaults to `sampled`. The docs flag the CORS `Access-Control-Allow-Headers` requirement.
- **View loading time.** "difference between the URL change and the first time the page has no activity". Activity means in-flight XHR/fetch, resource entries or DOM mutations, and the quiet period is 100 ms ([docs](https://docs.datadoghq.com/real_user_monitoring/browser/monitoring_page_performance/)).
- **Zone.js defence.** `getZoneJsOriginalValue(target, name)` reads `Zone.__symbol__(name)` originals, because zone patches have caused "memory leaks and high CPU usage" (DD:js-core/src/util/getZoneJsOriginalValue.ts:21-43).
  - A lint rule bans the patched `MutationObserver` (infinite loop), `setTimeout` (rendering loop in Angular) and `addEventListener` (Firefox leak) (DD:../eslint-local-rules/disallowZoneJsPatchedValues.ts:4-22).
- **Lazy loading.** The replay recorder is a dynamic `import()` chunk (DD:browser-rum/src/boot/lazyLoadRecorder.ts:5-20). That is the only vendor here whose heavy feature is not in the eager bundle by default.

### 2.3 New Relic `@newrelic/newrelic-capacitor-plugin`

Same design as cordova §2.2, with **worse** hot-path behaviour:

- **Side effects at import.**
  - `console.log/warn/error/assert/debug` are replaced the moment the module is evaluated, before `start()`.
  - Each call then does a `getAgentConfiguration()` bridge round-trip and `JSON.stringify`s the arguments (NRC:dist/esm/index.js:12-76).
  - `window` `error` / `unhandledrejection` listeners are also installed at import. The `error` listener dereferences `event.error.name` with no null check, which throws for resource errors (:81-97).
- **fetch.**
  - Every call waits on **three** chained bridge round-trips before the request leaves: `getHTTPHeadersTrackingFor` → `generateDistributedTracingHeaders` → `getAgentConfiguration` (:110-133).
  - It then injects `newrelic`/`traceparent`/`tracestate` into **every** request with no allowlist (:136-160).
  - It reads the full response with `response.clone().text()` and ships up to 4 KB of body over the bridge (:249-262).
- **XHR.**
  - All state lives in the one module-global `networkRequest` object (:98), the same race as cordova §2.2.
  - The full `responseText` is copied as `body` (:224).
  - **No header injection** on XHR.
  - So for Angular `HttpClient` (XHR on Angular ≤ 21, caps §2.2), NR tells you to write your own `HttpInterceptor` that calls `generateDistributedTracingHeaders()` (NRG:angular_http_client_instrumentation.md).
- **Offline.** Native storage, 100 MB default (NRC:README.md:19,111-112,714-718). dSYM upload is a manual Xcode phase (README.md:1039-1051).

### 2.4 Dynatrace (Cordova plugin on Capacitor)

- **Install.** Supports Capacitor 6+ and SPM on Capacitor 8 (DT:README.md:23,161). Instrumentation runs as a package.json script on `ionic:capacitor:build:before` or `capacitor:sync:after` (README.md:196-201). Otherwise the same two-agent model as cordova §2.3.
- **Capacitor cookie proxy.** `capacitorCookieProxy: true` is required if `CapacitorCookies` is used. It cannot be combined with `CapacitorCookies: true` (README.md:249-265).
- **Cookies on custom schemes.** Cordova §2.3's "cookies fail on `capacitor://`" point is repeated for Capacitor (README.md:977).
- **Measured overhead** on the Ionic conference app: iOS +4.2 MB, Android +0.1 MB (README.md:958-959).

### 2.5 Firebase (`@capacitor-firebase/performance`, `/crashlytics`)

- **Performance.** Manual `startTrace`/`stopTrace`/`incrementMetric`/`putAttribute`, each an async bridge call (FBP:dist/esm/definitions.d.ts:7-76).
- **Automatic iOS `_app_start`.** It "Stops after the first successful run loop that occurs after the application receives `UIApplicationDidBecomeActiveNotification`" ([Firebase docs](https://firebase.google.com/docs/perf-mon/app-start-foreground-background-traces)). In a Capacitor app that is **before** the WebView has parsed `main.js`, so it misses the part of startup users actually wait for.
- **Crashlytics.** `recordException({stacktrace})` takes stacktrace.js frames and has no source maps (FBC:README.md:203-207,607). `didCrashOnPreviousExecution()` (FBC:dist/esm/definitions.d.ts:58) matches cordova §2.5.

### 2.6 Bugsnag (`@bugsnag/browser-performance` + `@bugsnag/angular-performance`)

- **Angular routing.**
  - `AngularRoutingProvider` grabs the `Router` via an `APP_INITIALIZER`.
  - If the router isn't available yet it polls every 50 ms.
  - It starts a route-change span on `NavigationStart` and ends it **on settle** after `NavigationEnd/Cancel/Error` (BGA:index.js:5-62).
- **Route naming.** Route names come from `routeConfig.path`. A custom `matcher` becomes `/<custom URL matcher>` instead of being dropped (BGA:index.js:16-34).
  - edge-rum's `normaliseRoute` silently skips segments with no `path` (X:angular/src/RouterCapture.ts:24-35), so matcher routes collapse into their parent.
- **Settle.**
  - An aggregate of four settlers: a document `MutationObserver`, fetch in-flight, XHR in-flight and `loadEventEnd`.
  - 100 ms cooldown, 60 s hard timeout (BGP:on-settle/index.js:6-40; on-settle/dom-mutation-settler.js:7,20-24).
- **Propagation.** Off by default, and turned on per request by returning `propagateTraceContext: true` from `networkRequestCallback`. The header is `traceparent` only (BGP:auto-instrumentation/network-request-plugin.js:18-33,91).
- **Sampling.** Each span's sampling rate is derived from its trace id (`traceIdToSamplingRate`), so all spans in a trace agree.

### 2.7 Raygun, Embrace

- **Raygun.** Ionic is served by plain `raygun4js` ([docs](https://raygun.com/documentation/language-guides/javascript/crash-reporting/ionic/)). Cordova §2.6 applies unchanged, including the `file://` resource filter, which has no effect on Capacitor's `https://localhost`.
- **Embrace.** No Capacitor, Ionic or Cordova repo in the `embrace-io` GitHub org (checked 2026-10-27). The web SDK is a packaged OTel stack: 14 `@opentelemetry/*` deps plus `web-vitals` (EMB:package.json). It is 58 KB gzip at minimal init.

---

## 3. Tracing comparison

| Capability | Sentry | Datadog | NR Cap | Bugsnag | edge-rum today | Note |
|---|---|---|---|---|---|---|
| Route root span | Idle span, renamed at `ResolveEnd` | View, ends on 100 ms quiet | — | Ends on settle | `navigation` event, ends at `NavigationEnd` | Everyone measures past `NavigationEnd` |
| Router phase child | `ui.angular.routing` (Start→End) | — | — | — | — | caps §2.1 already plans guard / resolver / lazy-chunk phases (richer than Sentry) |
| Ionic page transition | — | — | — | — | `screen.duration` (fixed in #84) | **Unique to edge-rum** |
| HTTP fetch / XHR | both | both | both (header on fetch only) | both | both | parity |
| Capacitor plugin call | — | — | — | — | — | **Nobody.** caps §1.2 |
| App start | native only (cocoa, **unknown**) | — | native agent | `FullPageLoad` (web) | `lifecycle.cold_start_ms` (JS) | Nobody spans native t0 → first JS route render (gap C16) |
| Allowlist default | same-origin = none in Capacitor | none | **all** | none | — | |
| Header set | `sentry-trace`, `baggage` (+ opt-in `traceparent`) | `traceparent` + `tracestate` + `x-datadog-*` | `traceparent` + `tracestate` + `newrelic` | `traceparent` | — | trace-v3: `traceparent` only |
| Trace sampling | rate, optional consistent | deterministic per session | — | deterministic per trace id | session `sampleRate` (random roll, X:core/src/session/SessionManager.ts:125) | |

---

## 4. Ionic / Capacitor / Angular-specific captures

| Capture | Who ships it | edge-rum status | Cross-ref |
|---|---|---|---|
| Angular router + parameterised name | Sentry, Bugsnag | Has it (`normaliseRoute`). Lacks `matcher` handling | caps §2.1 |
| Angular `ErrorHandler` | Sentry (`createErrorHandler`), NR (manual docs, NRC:README.md:894-926) | Has it | caps §2.3 double-report risk applies to Sentry too (**unverified**) |
| `HttpClient` | Global XHR patch everywhere. NR needs a manual interceptor for headers | XHR patch shipped (#85) | caps §2.2 confirmed |
| Ionic lifecycle / overlays / back button | **Nobody** | `screen.duration` only | caps §3 |
| Capacitor bridge timing | **Nobody** | — | caps §1.2 |
| Native crash / ANR / hang | Sentry, NR, Dynatrace, Firebase | Has it | |
| iOS watchdog / OOM termination | Sentry (default on) | — (gap: no `app.exit`) | gap C39 |
| WebView render death | **Nobody** in readable code | — | caps §4.1 |
| OTA / live-update release | **Nobody**. Sentry uses the native release | — | caps §4.3 (confirmed as a market gap) |
| Stable stack paths | Sentry `app://` rewrite | — (no rewrite in `errors.ts`) | cordova §4 #3 |
| Source maps | Sentry wizard, Bugsnag `@bugsnag/source-maps`, Raygun server-side. Firebase none | — | |
| JS context mirrored to native crash | Sentry scope sync | — | cordova §4 #2 |

---

## 5. Lightweight design

| SDK | Eager gzip | Tree-shakable | Lazy | Side effects at import | Zone-aware |
|---|---|---|---|---|---|
| Datadog RUM | 66.4 KB (`-slim` 54.4) | no `sideEffects` flag | Recorder + profiler `import()` | — | **Yes** (originals + lint rule) |
| Embrace | 58.3 KB | `sideEffects: false` | — | — | **unknown** |
| Sentry Cap + tracing | 53.4 KB | `@sentry/browser` `sideEffects: false`; integrations opt-in | `lazyLoadIntegration` (CDN) | — | **Yes** (`Zone.root.run`) |
| Raygun | 24.7 KB | no | — | — | **unknown** |
| Bugsnag errors / perf | 16.3 / 13.5 KB | no flag | — | — | No (patched `MutationObserver` in settler) |
| NR Cap JS | 2.7 KB + native agent | no | — | **console, error, fetch, XHR patched at import** | No |
| edge-rum full stack | ~21 KB (baseline) | flag set but `init()` wires everything (baseline) | — | — | **No** |

**Zone finding (new):**

- `EdgeRumModule` calls `EdgeRum.init()` from an `APP_INITIALIZER` (X:angular/src/EdgeRumModule.ts:19-41).
- Angular runs initializers inside `ngZone.run(...)` (NG:core.mjs:34012, 34062-34063).
- So the following are all zone tasks:
  - the default-on `requestAnimationFrame` loop (X:core/src/instrumentation/frames.ts:27-29, read from `globalThis` at call time);
  - the 5 s `setInterval` flush (X:core/src/internal/pipeline.ts:88);
  - every listener and observer.
- In a zone-based app each such task can trigger `ApplicationRef.tick`. Angular's own guidance names rAF, `setTimeout` and `setInterval` from third-party libraries as the usual cause, with `runOutsideAngular` as the fix ([angular.dev zone pollution](https://angular.dev/best-practices/zone-pollution)).
- Ionic Angular apps on Angular ≤ 20 are zone-based by default (caps §2.3).
- **Unmeasured.** Baseline's per-frame figure was taken without zone.js and does not include this.
- Zoneless apps (default from 21) are unaffected.

---

## 6. Cross-references: confirms / contradicts

- **Confirms trace-v3 and caps §1.3 (CORS, allowlist):**
  - Sentry's same-origin default is in effect "inject nowhere" on Capacitor.
  - Datadog and Bugsnag are opt-in.
  - The one vendor that injects everywhere, NR, still has to give Angular users a manual interceptor. It also leaves XHR without headers.
- **Confirms caps §Summary "cheap and unique":** no competitor has plugin-call timing, Ionic UI capture, WebView death or live-update identity.
- **Confirms caps §4.3:** Sentry derives release from the native binary, so OTA bundles are misattributed. edge-rum can lead here.
- **Confirms cordova §2.2:** NR's hot-path problems got worse on Capacitor (three bridge hops per fetch instead of two, console patched at import).
- **Contradicts / extends baseline:**
  - Baseline's runtime numbers ("~10 µs/frame", "~6 ms script per 10 s idle") are a **lower bound** for Angular zone apps, because zone-triggered change detection is not counted (§5).
  - Baseline's conclusion that "size is not the problem" is **confirmed**: edge-rum is 2.5–3× smaller than every full-featured competitor.
- **Refines gap C16 (`app.start`):** Firebase's native `_app_start` ends at `didBecomeActive`, so a native-only end point understates hybrid startup. Anchor the end in JS (first route rendered / FCP).

---

## 7. Borrow list (ranked by value ÷ cost)

Cost is judged by bundle bytes, startup work and hot-path work. Byte figures are **estimates** by analogy with baseline's attribution table.

| # | Borrow | From | Value | Cost | Notes |
|---|---|---|---|---|---|
| 1 | **Escape the Angular zone**: grab `__zone_symbol__` originals for `requestAnimationFrame` / `setTimeout` / `setInterval` / `addEventListener` / `MutationObserver` / `PerformanceObserver`. Simplest form: run `EdgeRum.init()` inside `Zone.root.run` | Datadog `getZoneJsOriginalValue` + lint rule; Sentry `runOutsideAngular` | **High.** Probably removes app-wide change detection per frame and per flush | ~0.2 KB; **negative** hot-path cost | Core must not import Angular. Read `globalThis.Zone?.__symbol__` with no import. Add a lint rule like Datadog's. Measure tick count before/after on the demo |
| 2 | **Opt-in `traceparent` allowlist** (`string \| RegExp \| fn`). Empty means inject nowhere. Header is `traceparent` only. Keep the Capacitor-HTTP-vs-WebView distinction (trace-v3) | Datadog `allowedTracingUrls`, Bugsnag `propagateTraceContext`; anti-pattern NR | **High.** Gap C7/C8 without CORS breakage | ~0.3 KB; one match per request | No `tracestate`, `baggage` or vendor headers |
| 3 | **Rewrite stack frames**: strip `WEBVIEW_SERVER_URL` / `https://localhost` / `capacitor://localhost` / `ng://` and prefix `app://` | Sentry `rewriteframes.js` | **High** for grouping and source-map lookup across iOS/Android | ~0.2 KB; error path only | `WEBVIEW_SERVER_URL` is injected by Capacitor itself |
| 4 | **Build-time release id + source-map upload**, keyed by `(app.package_name, web bundle id)`, plus a runtime OTA bundle id (caps §4.3) | Sentry wizard / Debug IDs; Datadog / Bugsnag CLIs. **Fix Sentry's gap**: it uses the native release | **High.** Readable JS crashes, correct OTA attribution | 0 runtime bytes for the build step; ~0.3 KB for the OTA probe | Opens a market gap: nobody does OTA-correct releases |
| 5 | **Deterministic trace sampling** from session id / trace id | Datadog (`isSampled(session.id)`), Bugsnag (`traceIdToSamplingRate`) | Medium. Consistent traces across events and native | ~0.1 KB | Fits the existing session `sampleRate` |
| 6 | **Route `matcher` placeholder** in `normaliseRoute` | Bugsnag `<custom URL matcher>` | Low–medium. Stops silent route collapse | ~30 B | |
| 7 | **Navigation "loaded" end** after `NavigationEnd`: wait for in-flight fetch/XHR == 0 plus `ionViewDidEnter`, 100 ms quiet, hard cap | Datadog activity, Bugsnag settle, Sentry idle span | Medium–high. Real route load time | ~0.5 KB; counters only | **Without** a document-wide `MutationObserver` (see skip list). Reuse request counters edge-rum already has |
| 8 | **JS context → native mirror**, throttled to identify / screen change / last-N actions on flush, not per breadcrumb | Sentry scope sync (one bridge call per breadcrumb) | Medium. Native crashes get route and user | ~0.3 KB; a few bridge calls per session | Same as cordova §4 #2; don't copy Sentry's per-call bridge |
| 9 | **iOS watchdog / OOM termination** → `app.exit` on next launch | Sentry `enableWatchdogTerminationTracking` default true | Medium (gap C39) | Native only, startup check | Pairs with caps §4.1 renderer death |
| 10 | **Lazy-load optional heavy captures** via dynamic `import()` | Datadog recorder chunk | Low today (edge-rum has no heavy module). Policy for future features | 0 | Use it if anything over ~3 KB is added |

## 8. Skip list

| Skip | Who | Why |
|---|---|---|
| Session replay / DOM recorder | Sentry (+38 KB ceiling, SJS:.size-limit.js:43 vs 67), Datadog (12.3 KB lazy) | Biggest byte and CPU cost of any feature. Ionic replay rendering issues (getsentry/sentry-capacitor#1112). Violates the cardinal rule |
| Base64 envelope over the bridge to a native transport | Sentry Cap | +33% payload, a bridge hop per batch. edge-rum already sends through CapacitorHttp with JSON (Rule 2). Revisit only for cordova §4 #1 persistence |
| Console patching at import, per-call bridge config reads, response-body capture | NR Cap | Hot-path work and privacy risk on every request and every `console.log` |
| Inject headers on every request; vendor headers (`sentry-trace`, `baggage`, `tracestate`, `x-datadog-*`, `newrelic`) | NR, Sentry, Datadog | CORS breakage (trace-v3). The backend reads `traceparent` only |
| Zero-padded 64-bit trace ids | Datadog (`00-0000000000000000…`) | trace-v3 wire wants full 32-hex random ids |
| Document-wide `MutationObserver` "settle" | Bugsnag, Datadog | Ionic pages animate constantly. Observer work runs on every DOM change for the life of the app. Use request counters + Ionic events (#7) |
| Build-time agent download / HTML injection; cookie proxies wrapping `document.cookie` | Dynatrace | Fragile build hook, `document.cookie` hot-path overrides, iOS +4.2 MB. edge-rum uses no cookies |
| Component lifecycle decorators (`@TraceClass`, `TraceDirective`) | Sentry | Opt-in per component, low adoption, prototype patching. CD cost is better measured by aggregate (caps §2.4) |
| Exact peer-pinning of sibling SDKs + `postinstall` checks | Sentry Cap | Version-lock friction (pins 10.69.0 while 11.9.0 is out). Keep edge-rum's peer ranges loose |
| A full OTel web stack | Embrace (58 KB) | Bundle size. CLAUDE.md bans OTel on the wire |
| Datadog-style browser-only "Capacitor support" | Datadog | Loses native crashes, the core differentiator |

---

## 9. Unverified / open

- **Zone cost.** Change-detection ticks per second caused by edge-rum in a zone-based Ionic app. Needs a demo-app probe (`ApplicationRef.tick` counter) on device. The direction is source-derived; the size of the effect is unmeasured.
- **Closed agents.** Whether Dynatrace RUM JS or the NR/Dynatrace native agents instrument plugin calls, WebView death or Angular routes is **unknown**.
- **Sentry iOS app start.** Whether sentry-cocoa emits an app-start measurement in a Capacitor app (`enableAutoPerformanceTracing`) is **unknown**.
- **Datadog `WebViewTracking`.** Whether any Capacitor plugin wraps it is **unverified**. The docs list iOS/Android/Flutter/RN/KMP, not Capacitor.
- **Defaults for Raygun and Embrace.** Raygun's propagation and Embrace's propagation default and zone handling were not read.
- **Size method.** Sizes are esbuild minimal-init measurements and exclude framework adapters (`@sentry/angular`, `@bugsnag/angular-performance`). Real app sizes depend on the bundler and the integrations enabled. Bundlephobia whole-package numbers are much larger (for example `@sentry/browser` 145 KB, `@datadog/browser-rum` 67 KB) because they include every export.

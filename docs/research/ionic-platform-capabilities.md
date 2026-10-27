# Ionic / Angular / Capacitor platform capabilities: what is unique to observe, and at what cost

Ticket #72 (wayfinder map #68). Research only. As of 2026-10-27. Companion to `docs/research/lightweight-baseline.md` (#71, cost of what ships today) and the Cordova sibling `../edge_telemetry_cordova_sdk/docs/research/cordova-platform-capabilities.md` (same questions for the Cordova bridge; cited as `cordova §x`).

## Summary

- **Two existing captures are blind in real apps (found while checking "what exists").**
  - `IonicLifecycleCapture` listens for `ionViewDidEnter`/`ionViewDidLeave` on `document` in the **bubble** phase. Ionic dispatches these with `bubbles: false` on the page element (Ionic 7, 8 and 9). From the source, `screen.duration` never fires outside the unit tests, which dispatch on the listener target itself. Fix: add a capture-phase listener (`addEventListener(type, fn, true)`). That is what Ionic's own outlet does.
  - `requests.ts` patches only `fetch`. Angular `HttpClient` uses **XHR by default on Angular 16–21**; fetch becomes the default only in **22.0**. So most target apps' API calls produce no `http.request` today, only an unsanitised `resource_timing` row.
- **Cheap and unique (JS only, no new deps):**
  - Capacitor plugin-call timing and failures, by wrapping `Capacitor.nativePromise` / `nativeCallback`.
  - Router guard, resolver and lazy-chunk phases. These come from the router subscription we already have.
  - Ionic overlays (modal, sheet, popover, action sheet) and tabs. Their events bubble to `document`.
  - The keyboard. `@capacitor/keyboard` fires `window` events.
  - Ionic hardware-back (`ionBackButton`).
  - WebView version, already returned by the `Device.getInfo()` call we make.
  - Live-update bundle identity via core `WebView.getServerBasePath()`. Plugin-agnostic, zero deps.
- **Unique but native and moderately fragile:**
  - Android renderer death. Capacitor exposes a public `WebViewListener.onRenderProcessGone` fan-out. By default nobody handles it, so the **app process dies**, and our NDK handler currently sees only an unattributed crash.
  - iOS WebContent-process death. Capacitor silently `reload()`s. The only hook is `open` `WebViewDelegationHandler.webViewWebContentProcessDidTerminate`, which a plugin cannot override; it needs swizzling or a JS reload heuristic.
- **Costly or private:**
  - Angular change-detection cost in prod builds needs `ɵTracingService` (private, Angular ≥ 19.2) or patching `ApplicationRef._tick` (private). The public `enableProfiling()` / `ng.ɵsetProfiler` are **dev-mode only**.
  - Native-side per-plugin-call hooks don't exist on either platform.
- **Version floors that bite:**
  - Angular: `afterEveryRender`, `provideZonelessChangeDetection` and `provideBrowserGlobalErrorListeners` all need 20.0. Zoneless is the default from 21. Fetch-default `HttpClient` from 22.
  - Ionic 9 drops Angular 16/17 and needs Capacitor ≥ 7 and iOS 16.
  - Capacitor: iOS floor 13/14/15 for Capacitor 6/7/8; Android minSdk 22/23/24. Every Android minSdk is below API 26 (`onRenderProcessGone`, `getCurrentWebViewPackage`), so runtime guards are needed.
  - **Ionic Appflow shuts down 2027-12-31.** Capgo is the live-update target that matters.

## Method and citation legend

All upstream source was read as data from npm tarballs and one shallow clone in the session scratchpad, never run. Line numbers are from these snapshots.

| Prefix | Expands to | Version |
|---|---|---|
| `CAP:` | https://github.com/ionic-team/capacitor/blob/d19f1ea/ | main 2026-10-26 (= 8.5.3 on npm) |
| `NG:` | npm `@angular/core@22.2.3` `fesm2022/` | latest. Floors were checked against 18.2.14 (repo `node_modules`), 19.0.0, 19.2.0 and 20.0.0 tarballs |
| `NGH:` | npm `@angular/common@22.2.3` `fesm2022/_module-chunk.mjs` | latest. Default backend checked in 20.3.0, 21.0.0 and 22.0.0 |
| `IC:` | npm `@ionic/core@9.0.9` `dist/esm/` | latest. Lifecycle dispatch also checked in 7.0.0 and 8.0.0 |
| `IA:` | npm `@ionic/angular@9.0.9` `dist/common/` | latest |
| `CG:` | npm `@capgo/capacitor-updater@8.54.0` | latest |
| `LU:` | npm `@capacitor/live-updates@0.5.0` | latest (Appflow) |
| `APP:` / `KB:` | npm `@capacitor/app@8.1.2` / `@capacitor/keyboard@8.0.6` | latest |

Costs are **estimates**. Bundle bytes are a gzip guess by analogy with the attribution table in `lightweight-baseline.md`. Hot-path figures are by analogy with the measured `fetch` wrapper and `track()`. Nothing here was measured on a device.

## What edge-rum captures today (stack-specific)

| Area | Today | File |
|---|---|---|
| Angular router | `NavigationStart/End/Cancel/Error` → `navigation`, plus `app.crash` (cause `NavigationError`). Other router events are ignored | `packages/angular/src/RouterCapture.ts` |
| Angular errors | `ErrorHandler` subclass → `captureError` with component name parsed from the stack | `packages/angular/src/ErrorCapture.ts` |
| Ionic lifecycle | `ionViewDidEnter/DidLeave` → `screen.duration`. **Bubble-phase listener; see §3.1** | `packages/angular/src/IonicLifecycleCapture.ts:39-40` |
| HTTP | `fetch` patch only. No XHR, no `HttpClient` interceptor | `packages/core/src/instrumentation/requests.ts` |
| SDK transport on native | Goes through `CapacitorHttp.request` (no CORS) | `packages/capacitor/src/capacitor-http-fetch.ts` |
| App lifecycle, network, device | `@capacitor/app` `appStateChange`, `@capacitor/network`, `@capacitor/device` `getInfo()` (`webViewVersion` returned but **dropped**) | `packages/capacitor/src/{LifecycleCapture,NetworkCapture,DeviceContext}.ts` |
| Native | Crashes (PLCrashReporter / JVM / NDK), ANR, hang, frames, memory | `packages/capacitor/{ios,android}/` |
| Not captured | Plugin calls, WebView death, live-update identity, overlays, tabs, keyboard, back button, guard/resolver/lazy-load timing, CD cost | — |

---

## 1. Capacitor bridge

### 1.1 How a plugin call flows (Capacitor 8)

- `registerPlugin(name)` returns a `Proxy`. For each method it checks `Capacitor.PluginHeaders` (injected natively: plugin name, methods, `rtype`). A native `promise` method becomes `cap.nativePromise(plugin, method, options)`; a callback method (listeners, watches) becomes `cap.nativeCallback(...)` (`CAP:core/src/runtime.ts:43-85`).
  - **`cap.nativePromise` is looked up on the shared `window.Capacitor` object at call time**, not captured at registration. The bridge (`native-bridge.js`, injected at document start) and `@capacitor/core` mutate the same object (`CAP:core/native-bridge.ts:1117-1124`). A wrapper installed at any point therefore sees every later call from every plugin, with no ordering problem. That is unlike the Cordova `cordova/exec` module capture (cordova §2.3).
- `nativePromise` → `toNative` stores `{resolve, reject}` in a closure-private `callbacks` map. It posts `{callbackId, pluginId, methodName, options}` via `androidBridge.postMessage` (androidx `WebMessageListener` when supported, else `addJavascriptInterface`; `CAP:android/.../MessageHandler.java:20-45`) or `webkit.messageHandlers.bridge` (`CAP:core/native-bridge.ts:940-1033`).
- Results: Android sets `androidBridge.onmessage` → private `returnResult`. iOS calls `cap.fromNative` (`CAP:core/native-bridge.ts:1036-1049`). **So wrapping `fromNative` misses Android**; wrap at `nativePromise`/`nativeCallback` instead.
- Errors arrive as `CapacitorException` with `code` (`UNIMPLEMENTED`, `UNAVAILABLE`, or plugin-defined). An unknown plugin rejects with "unable to find plugin" (`CAP:android/.../Bridge.java:822-829`).
- **Native side, Android:** `Bridge.callPluginMethod` posts `plugin.invoke` to the plugin's handler thread (`CAP:android/.../Bridge.java:822-860`). There is no listener and no timing hook; `MessageHandler` is constructed by `Bridge`.
- **Native side, iOS:** `CapacitorBridge.handleJSCall` and `toJs` are `internal`, not `public` (`CAP:ios/Capacitor/Capacitor/CapacitorBridge.swift:489-623`).
- **Conclusion:** no supported native per-call hook exists. JS is the only clean seam.

### 1.2 Capabilities

| Capability | Mechanism | Floor | Web / iOS / Android | Cost | Risk |
|---|---|---|---|---|---|
| **Plugin-call latency + error rate** per `plugin.method` (new) | Replace `Capacitor.nativePromise` with a wrapper: `t0`; call original; `.then/.catch` → aggregate `{plugin, method, count, p50/p95 ms, errors by code}` per screen or window | Capacitor 3+ (shape unchanged through 8.5.3) | — / yes / yes | ~0.4 KB. 2× `performance.now()` + one closure per call (sub-µs). Emit **aggregates**, not per call | Low. `nativePromise` is undocumented but stable across 5–8. Must **exclude our own plugins and transport** (`CapacitorHttp` from `capacitor-http-fetch.ts`, `EdgeRumCrash`, Device, Preferences) or the SDK measures itself |
| Listener / stream calls (new) | Wrap `nativeCallback`. Count callback deliveries per `plugin.method` | 3+ | — / yes / yes | tiny | Low. Duration means nothing for `keepAlive` streams; count only |
| Hung plugin calls (new) | Keep the start time per wrapped promise and flag ones open longer than N s at flush or `session.finalized` | — | — / yes / yes | tiny | Low. Same signal as cordova §2.3 "never answered" |
| Installed native plugin inventory (new) | Read `Capacitor.PluginHeaders` names once at init (`CAP:android/.../JSExport.java:91`, `CAP:ios/.../JSExport.swift:101`) | 3+ | — / yes / yes | ~0.1 KB, once | Low. Useful crash context ("which plugins are in this build") |
| Native per-call timing | None public (above). Would need subclassing `Bridge` / swizzling internal Swift | — | — | — | High. Do not do it |

### 1.3 `CapacitorHttp` and request capture

- When enabled (`plugins.CapacitorHttp.enabled`, default **false**, `CAP:core/http.md:21`), `native-bridge.js` **replaces `window.fetch` and patches `XMLHttpRequest.prototype.open/send`** at document start. It saves the originals as `CapacitorWebFetch` / `CapacitorWebXMLHttpRequest` (`CAP:core/native-bridge.ts:452-490, 625-700`).
- **Two routes since Capacitor 6.0** (the interceptor first appears at tag `6.0.0`; absent in `5.0.0` and `5.7.0`):
  - `GET/HEAD/OPTIONS/TRACE` are rewritten to the WebView fetch of `https://localhost/_capacitor_http_interceptor_?u=<url>`. The native local server performs the request (`CAP:core/native-bridge.ts:125-138, 505-533`; Android `CAP:android/.../WebViewLocalServer.java:187, 290-320`).
  - Other methods go through `cap.nativePromise('CapacitorHttp','request')` (`CAP:core/native-bridge.ts:567`).
  - Each patched request also calls `console.time/timeEnd` (`:537, :600`). Console noise, and on native it is bridged to the native log.
- **Implications for edge-rum:**
  - Our `fetch` wrapper is installed after the bridge, so it wraps Capacitor's patched fetch and still sees the **original URL**, method, status and wall time. Good. XHR is still uncaptured (§2.5).
  - **Resource Timing sees proxy URLs.** GETs appear as `https://localhost/_capacitor_http_interceptor_?u=https%3A%2F%2Fapi…`. Non-GETs appear not at all. `perf-observer.ts:77` emits the raw `resource_name`, so the real API URL (query string included) leaks unsanitised inside a query param. Unwrap `u=` and apply `sanitizeUrl`, or drop these rows.
  - **Bridge capture double-counts.** Non-GET `fetch` shows up as both `http.request` and a `CapacitorHttp.request` plugin call. Exclude `CapacitorHttp` from bridge aggregates.
- **`traceparent` injection:**
  - *CapacitorHttp off* (default). The WebView origin is `capacitor://localhost` (iOS) or `https://localhost` (Android), so every API call is cross-origin. Adding `traceparent` makes the request non-simple, so it **triggers a CORS preflight**. Backends that don't list `traceparent` in `Access-Control-Allow-Headers` will **fail the real request**. Header injection must be opt-in per origin (allow-list, as Datadog `allowedTracingUrls` does), never global.
  - *CapacitorHttp on*. Requests are native, so CORS does not apply and the header passes through. Android forwards all WebView request headers on the proxy path (`WebViewLocalServer.java:294-296`). iOS header forwarding on the proxy path is **unverified**.
- Cost of adding an XHR patch: ~0.6 KB, per-request cost like `fetch` (below noise). Risk: low. Patch `XMLHttpRequest.prototype` *after* Capacitor so we wrap its patch; never replace the constructor.

### 1.4 Capacitor 6 / 7 / 8 differences that matter here

| | 6 | 7 | 8 |
|---|---|---|---|
| iOS floor ([6](https://github.com/ionic-team/capacitor/blob/6.0.0/ios/Capacitor.podspec), [7](https://github.com/ionic-team/capacitor/blob/7.0.0/ios/Capacitor.podspec), [8](https://github.com/ionic-team/capacitor/blob/8.0.0/ios/Capacitor.podspec) podspecs) | 13.0 | 14.0 | 15.0 |
| Android minSdk / target ([6](https://capacitorjs.com/docs/updating/6-0), [7](https://capacitorjs.com/docs/updating/7-0), [8](https://capacitorjs.com/docs/updating/8-0)) | 22 / 34 | 23 / 35 | 24 / 36 |
| `_capacitor_http_interceptor_` GET proxy | yes (new) | yes | yes |
| iOS plugin registration | Auto-registration removed; CLI-generated list; local plugins need a custom VC ([6-0](https://capacitorjs.com/docs/updating/6-0)) | — | SPM default for new iOS projects ([8-0](https://capacitorjs.com/docs/updating/8-0)) |
| Other | — | `bundledWebRuntime` removed | `density` added to `configChanges` (WebView no longer reloads on density change), System Bars core plugin, `adjustMarginsForEdgeToEdge` removed ([8-0](https://capacitorjs.com/docs/updating/8-0)) |

- Our capacitor peer range is `>=5.0.0`. Capacitor 5 has no GET proxy, so the proxy-URL handling must be conditional.
- Android minSdk is 22–24 on every supported major. API-26 WebView APIs (§4) need `Build.VERSION.SDK_INT` guards.

---

## 2. Angular internals

### 2.1 Router: guards, resolvers, lazy chunks (cheap; same subscription)

- `RouterCapture` already subscribes to `router.events` and switches on `event.type`. The `EventType` values (`NG router:1220-1236`, same in 18 and 22) are:
  - `RoutesRecognized`=4
  - `ResolveStart/End`=5/6
  - `GuardsCheckStart/End`=7/8
  - `RouteConfigLoadStart/End`=9/10
  - `ActivationStart/End`=13/14
  - `NavigationSkipped`=16
- New attributes on the existing `navigation` event, all from the same callback:
  - `navigation.duration_ms` (Start→End)
  - `navigation.guards_ms`
  - `navigation.resolve_ms`
  - `navigation.lazy_load_ms` (`RouteConfigLoadStart/End` = lazy `loadChildren`/`loadComponent` chunk fetch + eval)
  - `navigation.recognize_ms`
- On a cancelled navigation, record which phase it was in (guard-cancel vs redirect).
- **Cost:** ~0.3 KB, a few `performance.now()` per navigation. **Floor:** all events exist ≪ Angular 16. **Risk:** none (public API).
- `RouteConfigLoad*` fires per route *config*, not per JS chunk. A route whose chunk is already cached fires nothing. Nested lazy routes produce several pairs; sum them.

### 2.2 `HttpClient` interceptors

| Option | Sees | Floor | Cost | Risk |
|---|---|---|---|---|
| **Global XHR patch** (core, framework-agnostic) | All `HttpClient` traffic on Angular ≤ 21 (XHR default) and any other XHR | — | ~0.6 KB | Low. **Recommended**, fixes the gap |
| Functional interceptor `withInterceptors([edgeRumInterceptor])` | Logical request (`HttpRequest`, `HttpContext`, retries visible as separate passes) regardless of backend | 15 | ~0.3 KB | Low, but **opt-in by the app**: standalone `provideHttpClient()` only runs interceptors passed to it. Our `EdgeRumModule` can only register a DI `HTTP_INTERCEPTORS` provider, which runs only with `withInterceptorsFromDi()` / `HttpClientModule`. The root token `HTTP_ROOT_INTERCEPTOR_FNS` is not publicly exported (`NGH:1224`) |

- Default backend by version:
  - 20.3.0 and 21.0.0: `inject(FETCH_BACKEND, {optional}) ?? inject(HttpXhrBackend)`, i.e. XHR unless the app opted into `withFetch()`.
  - 22.0.0: `inject(FetchBackend)`. Adds `withXhr()`; `withFetch()` deprecated ([withXhr](https://angular.dev/api/common/http/withXhr), [setup guide](https://angular.dev/guide/http/setup)).
- `FetchBackend` calls `globalThis.fetch(...)` at request time (`NGH:770-772`), so our `fetch` patch sees it on 22+.
- Use the interceptor only as an optional add-on (e.g. per-request `HttpContext` opt-out, or `traceparent` with the allow-list).

### 2.3 `ErrorHandler` (existing) and zoneless

- `ErrorHandler` still receives template, lifecycle and listener errors in zoneless apps.
- **Double-report risk.** `provideBrowserGlobalErrorListeners()` (Angular 20+, `NG:_pending_tasks-chunk`; absent in 19.x) forwards `window` `error` / `unhandledrejection` into `ErrorHandler`. Core `errors.ts` already listens to those. A zoneless or 20+ app that adds the provider produces **two `app.crash` events per uncaught error** (one `AngularError`, one `webview`). Dedupe by error identity within a short window.
- Zoneless is the default in 21+. In 20 it is opt-in via `provideZonelessChangeDetection()`; in 18–19 via `provideExperimentalZonelessChangeDetection()` ([zoneless guide](https://angular.dev/guide/zoneless); `NG` export lists 19.2 vs 20.0). Under zoneless, `NgZone.onStable/onMicrotaskEmpty` **never emit** and `isStable` is always true. Any capture keyed on zone stability is dead there.

### 2.4 Change-detection cost

| Option | What it gives | Prod? | Floor | Cost | Risk |
|---|---|---|---|---|---|
| `enableProfiling()` / `ng.ɵsetProfiler` | Per-component, per-hook DevTools track | **No.** `enableProfiling` only installs profilers under `ngDevMode` (`NG:_debug_node-chunk.mjs:12876-12887`). `ɵsetProfiler` is reachable only via the dev-mode `window.ng` global (`NG:_debug_node-chunk.mjs:12911`). Docs: "works exclusively in development mode" ([profiling guide](https://angular.dev/best-practices/profiling-with-chrome-devtools)) | — | — | Unusable for RUM |
| **`ɵTracingService`** (provide the token) | Angular calls `snapshot()` whenever CD is scheduled (`ChangeDetectionSchedulerImpl.notify`, `NG:_debug_node-chunk.mjs:19581`). It wraps every tick in `snapshot.run(CHANGE_DETECTION, tickImpl)` (`:13295-13300`) and afterRender sequences in `AFTER_NEXT_RENDER`. Gives exact per-tick duration and count in **prod**, plus the scheduling cause linkage | yes | **19.2** (absent in 19.0) | ~0.4 KB in `@nathanclaire/rum-angular`. 2 `performance.now()` per tick. Must aggregate (p95 tick ms, ticks per screen) | **High.** `ɵ`-private, no contract. Designed for Google-internal tracing. Coverage in zone-based apps depends on the hybrid scheduler calling `notify` (**unverified**) |
| Patch `ApplicationRef.prototype._tick` (or `tick` on 18) | Per-tick duration | yes | any | tiny | **High.** Private. The call site moved: 18.2 zone path calls `tick()` and zoneless calls `_tick()`; 22 calls `_tick()` from both schedulers (`NG:core.mjs:1568`, `_debug_node-chunk.mjs:13529, 19628`) |
| `NgZone.onUnstable/onStable` | Zone-turn duration (includes the tick) | zone apps only | any | tiny | Low, but dead under zoneless (default 21+) |
| `afterEveryRender` / `afterNextRender` | Render *end* timestamp only (no start) | yes | `afterEveryRender` 20.0 (`afterRender` was renamed; gone from 22 exports) | tiny | Low, but not a cost measure on its own |
| LoAF `long-animation-frame` script attribution | Long frames with `sourceFunctionName` | yes | Android WebView 123+; **never on iOS** (cordova §4.1) | ~0.4 KB | Low. Framework-agnostic; partly overlaps the existing longtask observer |

- Recommendation for the catalogue: **don't ship CD cost as a default capture.** The frame summaries (ADR-030) plus LoAF on Android already answer "is the UI janky". The only prod-grade CD hook is `ɵ`-private. If wanted, make it an opt-in Angular-package flag pinned to tested Angular majors.

### 2.5 Signals

- No public hook observes signal writes or effect runs. The primitives (`@angular/core/primitives/signals`, `ɵSIGNAL`) are internal.
- RUM value is low: signal churn shows up as CD ticks (§2.4). Skip.

---

## 3. Ionic UI lifecycle

### 3.1 Page lifecycle (existing capture is broken)

- `@ionic/core` fires `ionViewWillEnter/DidEnter/WillLeave/DidLeave` with `new CustomEvent(name, { bubbles: false })` on the page element (`IC:index-z9vdZN7I.js:283-291`; identical in 7.0.0 and 8.0.0).
- `@ionic/angular` binds page hooks as direct element listeners (`IA:providers/angular-delegate.js:188-208`). Its own `IonRouterOutlet` comment says: "Capture listeners … see events dispatched on pages in this outlet even though they don't bubble" (`IA:directives/navigation/router-outlet.js:179`).
- **`IonicLifecycleCapture` registers on `document` without `capture`** (`packages/angular/src/IonicLifecycleCapture.ts:39-40`). A non-bubbling event never reaches a bubble-phase `document` listener, so `__beginScreen` is never called in a real app. The tests pass because they dispatch on the listener target itself (`packages/angular/test/ionic-lifecycle-capture.test.ts:23-25`). **Needs device confirmation**, but the source is unambiguous.
- **Fix (cheap, no per-page code).** Use `document.addEventListener('ionViewDidEnter', fn, true)` (and the leave events). `event.target` is the page element: `tagName` gives the component selector, and `closest('ion-router-outlet')` gives nesting. Add `WillEnter→DidEnter` for **transition duration** (animation + mount), a cheap new attribute.
- **Ionic 9 quirk.** `IonRouterOutlet` re-dispatches lifecycle events to a parent's active page and swallows repeat leaves with `stopImmediatePropagation` in a capture listener on the page (`IA:router-outlet.js:13-30, 150-185`). A `document` capture listener runs *before* page-level capture listeners, so we may see a leave that the page itself never sees. De-dupe per page element.

### 3.2 Overlays, tabs, gestures, menus

| Signal | Event (bubbles to `document`?) | Floor | Cost | Notes |
|---|---|---|---|---|
| Modal / sheet open, close, dwell | `ionModalWillPresent/DidPresent/WillDismiss/DidDismiss` (Stencil flags 7 = bubbles + composed + cancelable). `detail.role` on dismiss (`backdrop`, `gesture`, `cancel`, custom) | Ionic 4+ | ~0.3 KB for all overlays | Gives "modal shown N ms, dismissed by swipe vs button". Generic `didPresent`/`didDismiss` also fire |
| Sheet breakpoint, drag | `ionBreakpointDidChange`, `ionDragStart/End` (flag 7) | sheet modal (Ionic 6+) | incl. | Drag events are high-frequency only for `ionDragMove`; ignore it |
| Popover, action sheet, alert, toast, loading | `ion{Popover,ActionSheet,…}Did{Present,Dismiss}` (flag 7) | 4+ | incl. | Loading-overlay dwell is a cheap "user blocked on spinner" metric |
| Tabs | `ionTabsWillChange/DidChange` (flags 3 = bubbles + composed) | 5+ | tiny | In Angular tabs the route also changes, so it's mostly redundant with `navigation`; useful only as `navigation.method=tab` |
| Swipe-back gesture | No global event. The completed swipe surfaces as router `popstate` (`navigation.method=pop`); a cancelled swipe fires only `ionViewWillEnter` (`IA:router-outlet.js:17`) | — | — | Count cancelled swipes = WillEnter without DidEnter. Ionic 9 defaults swipe-back on in iOS mode, off in MD ([9-0](https://ionicframework.com/docs/updating/9-0)) |
| Generic gestures (`createGesture`) | None global | — | — | Not observable without per-gesture code. Skip |

### 3.3 Keyboard and back button

- **Keyboard.** `@capacitor/keyboard` fires `window` events `keyboardWillShow/DidShow/WillHide/DidHide` with `keyboardHeight` via `bridge.triggerWindowJSEvent` (`KB:android/.../KeyboardPlugin.java:78-84`, `KB:ios/.../Keyboard.m:218-262`). Ionic re-emits them as `ionKeyboardDidShow` (`IC:keyboard-B4Y-Gph8.js:59-61`).
  - A `window` listener costs **no import and no plugin dependency**. Signals: keyboard-open count and dwell per screen, and show latency (Will→Did).
  - Only when the app has the plugin installed. On web, Ionic derives keyboard state from `visualViewport` (`IC:input-shims`).
  - Cost ~0.15 KB. Risk low.
- **Hardware back (Android).** Ionic dispatches `ionBackButton` on `document` from the `backbutton` DOM event (`IC:overlays-DmDY-El7.js:53-108`). A passive `document` listener counts presses per screen. Pair with the next `navigation` to classify press → pop, overlay close, or exit.
- **Do not** subscribe to `App.addListener('backButton')` or add a `document` `backbutton` listener from the SDK.
  - `AppPlugin` disables the default WebView-back behaviour as soon as **any** `backButton` listener exists (`APP:android/.../AppPlugin.java:46-58`).
  - `native-bridge.js` turns any `document.addEventListener('backbutton')` into an `App.addListener('backButton')` (`CAP:core/native-bridge.ts:262-280`).
  - Either one silently changes a non-Ionic host app's back navigation. `ionBackButton` is Ionic-only but safe.
- Ionic 9 still gates `CloseWatcher` behind `experimentalCloseWatcher` (`IC:overlays-DmDY-El7.js:22`).

### 3.4 Ionic 7 vs 8 vs 9

| | 7 | 8 | 9 |
|---|---|---|---|
| Angular | 14+ (**unverified**) | 16+ ([8-0](https://ionicframework.com/docs/updating/8-0)) | 18–22 ([9-0](https://ionicframework.com/docs/updating/9-0)) |
| iOS / Chrome | — | iOS 15+, Chrome 89+ | iOS 16+, Chrome 89+, Capacitor ≥ 7 for native detection |
| Lifecycle dispatch | `bubbles:false` | `bubbles:false` | `bubbles:false`; outlet forwards to parent pages (§3.1) |
| Notes | — | — | Angular 22 default `OnPush` (page hooks call `markForCheck`) |

- **Latest Ionic is 9.0.9, not 8.** Our Angular peer is `>=16`, so Ionic 9 users are on Angular 18+.

---

## 4. WebView health and live updates

### 4.1 Renderer / content-process death

| | Android | iOS |
|---|---|---|
| OS hook | `WebViewClient.onRenderProcessGone(view, detail)`, API 26. `detail.didCrash()` (false = killed for memory) and `rendererPriorityAtExit()`. Returning false crashes or kills the app; returning true requires destroying and recreating the WebView ([managing WebView](https://developer.android.com/develop/ui/views/layout/webapps/managing-webview)) | `WKNavigationDelegate.webViewWebContentProcessDidTerminate(_:)`, iOS 9.0 ([Apple](https://developer.apple.com/documentation/webkit/wknavigationdelegate/webviewwebcontentprocessdidterminate(_:))) |
| Capacitor default | `BridgeWebViewClient` fans out to `bridge.getWebViewListeners()`. With no listener returning true it returns false, so **the app process dies** (`CAP:android/.../BridgeWebViewClient.java:91-104`) | `WebViewDelegationHandler` logs, `bridge.reset()` (drops stored calls and listeners) and **silently `webView.reload()`s at the current URL**. The JS state is gone, the user sees a flash or blank, and the native process lives on (`CAP:ios/.../WebViewDelegationHandler.swift:164-168`) |
| Supported plugin hook | **Yes.** `bridge.addWebViewListener(WebViewListener)` is public and has `onRenderProcessGone`, `onPageStarted`, `onPageLoaded`, `onReceivedError`, `onReceivedHttpError` and `onPageCommitVisible` (`CAP:android/.../WebViewListener.java`, `Bridge.java:1497-1507`) | **No.** The handler is constructed inside `CAPBridgeViewController.loadView` (`CAPBridgeViewController.swift:44`). `bridge.webViewDelegationHandler` is `public private(set)`. Its methods are `open`, but only a custom VC subclass replacing `loadView` could subclass it |
| What edge-rum should do | In the existing Android plugin's `load()`, add a `WebViewListener`. In `onRenderProcessGone`, synchronously persist `{did_crash, priority_at_exit, url, ts}` and **return false** (keep default). On next launch, emit `app.crash` with cause `WebViewRendererGone` and `runtime=webview`. That also explains the otherwise-unattributed native abort our NDK/JVM handlers record (that the default path raises a native abort vs a Java exception is **unverified**) | (a) **Swizzle** `-[WebViewDelegationHandler webViewWebContentProcessDidTerminate:]` (NSObject subclass, `@objc` protocol method), record, then call the original. (b) **JS heuristic, no native:** keep an "alive" marker in `sessionStorage` / `localStorage`; on boot, `performance.getEntriesByType('navigation')[0].type === 'reload'` with no prior `pagehide` while the native app stayed foreground → `webview.reloaded`. Whether sessionStorage survives a WebContent crash is **unverified**; localStorage is safer (same open question as cordova §5) |
| Floor | minSdk 22–24, so guard `SDK_INT >= 26` | all |
| Cost | ~2 KB bytecode, zero steady-state. Callback only on death | Swizzle: tiny. Heuristic: ~0.3 KB JS, one storage write at boot and one on `pagehide` |
| Risk | Low (public Capacitor API since `WebViewListener` gained `onRenderProcessGone`; introduction version **unverified**, present in 8.5.3) | Swizzle: **medium–high** (class or selector rename breaks it silently; guard with `responds(to:)`). Heuristic: false positives from app-initiated `location.reload()` |

- **Android renderer hang** (not death): androidx.webkit `WebViewRenderProcessClient.onRenderProcessUnresponsive` (API 29+, feature-gated; cordova §5). Capacitor already depends on `androidx.webkit:1.14.0` as an `implementation` dep (`CAP:android/capacitor/build.gradle:7, 86`), so our plugin must declare it itself (deduped).
  - This is the only native signal for a JS main-thread hang on Android. Our `AnrWatchdog` watches the *app* main thread, not the renderer.
  - Cost small. Risk low.
- **Page lifecycle as health:** `WebViewListener.onPageStarted` after the first load = a WebView reload (crash-recovery, live-update `reload()`, or app `location.reload`). It is a cheap Android-only counter.

### 4.2 WebView version

| Source | What | Floor | Cost | Risk |
|---|---|---|---|---|
| `Device.getInfo().webViewVersion` | Version string. **Already fetched by `DeviceContext.ts:251`, then discarded.** Add `device.webview_version` | `@capacitor/device` 1.0 | zero | none |
| Android `WebView.getCurrentWebViewPackage()` (API 26) / `WebViewCompat.getCurrentWebViewPackage()` | `packageName` + `versionName`. Distinguishes Android System WebView vs Chrome vs Huawei/OEM forks. Capacitor itself does this in `Bridge.isMinimumWebViewInstalled` (`CAP:android/.../Bridge.java:328-340`; defaults min 60, Huawei 10). Can return `null` ([managing WebView](https://developer.android.com/develop/ui/views/layout/webapps/managing-webview)) | API 26 / androidx | one native call at init, ~0.5 KB | Low |
| UA `Chrome/NNN` (Android) | Major version | — | already parsed | Low. UA reduction freezes minor parts |
| iOS | WKWebView = iOS version (cordova §4.1). `device.platform_version` already covers it | — | — | — |

### 4.3 Live-update bundle identity

The problem:
- OTA updates swap the web bundle under an unchanged native `app.version` / `app.build_number`.
- Both Capgo and Appflow serve the new bundle by calling Capacitor's `setServerBasePath` (`CG:android/.../CapacitorUpdaterPlugin.java:3241-3250`; `LU:` Android and iOS sources). Script URLs therefore stay `https://localhost/main.<hash>.js`.
- Result: crashes are attributed to the wrong release, and source-map lookup by URL alone can collide across bundles if hashing is off.
- Every event needs a **web-bundle identity**, and maps must be uploaded keyed by it.

| Source | API | Floor | Cost | Risk |
|---|---|---|---|---|
| **Plugin-agnostic** | Core `WebView.getServerBasePath()` → `{path}` (`CAP:core/src/core-plugins.ts:6-17`; exported since ≤ 5.0.0). The path changes when an OTA bundle is active. Emit `app.web_bundle_path` or a short hash of it. Changes only after a reload, so read once per page load | Capacitor 3+ (**unverified** pre-5) | ~0.1 KB, one bridge call at init | Low. The path layout is the updater's business; treat it as opaque |
| **Capgo** | `CapacitorUpdater.current()` → `{bundle:{id, version, downloaded, checksum, status}, native}`. `bundle.id === "builtin"` when no OTA (`CG:dist/esm/definitions.d.ts:890-907, 2282-2288, 2579-2582`). Events: `updateFailed`, `downloadFailed`, `appReloaded`, `appReady`, `set` (`:1372-1511`) | Capgo 4+ (`updateFailed` `@since 4.0.0`) | ~0.3 KB. Call via `Capacitor.Plugins.CapacitorUpdater` when `isPluginAvailable('CapacitorUpdater')`, **no import, no peer dep** | Low (public, documented). **Rollback signal:** Capgo rolls back if `notifyAppReady()` is not called within `appReadyTimeout` (default 10 s; `:13-16, 560-587`). `updateFailed` / a `builtin` fallback next launch = bad OTA. High-value release-health event |
| **Appflow, Capacitor** (`@capacitor/live-updates`) | `sync()` → `SyncResult.snapshot {id, buildId}`, `getConfig()` → `{appId, channel}`. **No "current snapshot" getter**: identity is known only if the app's own `sync()` result is captured (`LU:dist/esm/definitions.d.ts:67-87`; README API: `sync`, `setConfig`, `getConfig`, `resetConfig`, `reload`) | peer `@capacitor/core >=8` | ~0.2 KB | Medium. Wrapping `sync` via the §1.2 bridge wrapper (`LiveUpdates.sync` result) is possible, otherwise fall back to `getServerBasePath`. **Appflow access ends 2027-12-31; no new sales** ([Ionic blog](https://ionic.io/blog/?p=6282)) |
| Appflow, Cordova (`cordova-plugin-ionic`) | `getCurrentVersion()` → `{versionId, buildId, channel, binaryVersionName, binaryVersionCode}`. `getConfiguration()` → `currentVersionId/currentBuildId` ([Appflow Deploy API](https://ionic.io/docs/appflow/deploy/api)) | — | — | Legacy. Out of scope for Capacitor apps |

- **Source-map implication.** The upload key must be `(app.package_name, web bundle id)`, not `app.version`. Capgo's `bundle.version` is set at `npx @capgo/cli bundle upload` time. That is the natural hook to upload maps with the same id and to inject the id into the bundle (Sentry-style release injection). A build step that writes a `release` constant into `main.js` is updater-agnostic and costs nothing at runtime. It is the most robust option and works without any plugin.

---

## Summary table

E = extends an existing capture; N = new. Cost: bundle gzip / startup / hot path.

| # | Capability | E/N | Web | iOS | Android | Floor | Cost | Risk |
|---|---|---|---|---|---|---|---|---|
| 1 | **Fix Ionic lifecycle listener (capture phase)** + transition ms | E | yes | yes | yes | Ionic 4+ | ~0 / 0 / 0 | none |
| 2 | **XHR capture** (fixes `HttpClient` ≤ 21) | E | yes | yes | yes | — | 0.6 KB / 0 / sub-µs | low |
| 3 | Plugin-call latency/errors (`nativePromise` wrap) | N | — | yes | yes | Cap 3+ | 0.4 KB / 0 / sub-µs per call | low (undocumented, stable) |
| 4 | Router guard / resolve / lazy-chunk / recognize ms | E | yes | yes | yes | ≪ Ng 16 | 0.3 KB / 0 / per nav | none |
| 5 | Overlays + tabs + loading dwell | N | yes | yes | yes | Ionic 4+ | 0.3 KB / 0 / per event | none |
| 6 | Keyboard open/dwell (window events) | N | — | yes | yes | `@capacitor/keyboard` | 0.15 KB / 0 / per event | none |
| 7 | Hardware back presses (`ionBackButton`) | N | — | — | yes | Ionic | 0.1 KB / 0 / 0 | none (never use `App` `backButton`) |
| 8 | `device.webview_version` | E | — | yes | yes | Device 1.0 | ~0 | none |
| 9 | WebView package (System WebView / Chrome / OEM) | N | — | — | yes | API 26 | native ~0.5 KB / 1 call | low |
| 10 | **Android renderer death** (`WebViewListener`) | N | — | — | yes | API 26 | native ~2 KB / 0 / 0 | low |
| 11 | Android renderer unresponsive | N | — | — | yes | API 29 + feature | native small | low |
| 12 | **iOS WebContent termination** | N | — | yes | — | iOS 9 | swizzle tiny, or JS 0.3 KB | med–high (swizzle) / med (heuristic) |
| 13 | **Web-bundle identity** (`getServerBasePath`) | N | — | yes | yes | Cap 3–5+ | 0.1 KB / 1 bridge call | low |
| 14 | Capgo bundle id + OTA failure/rollback | N | — | yes | yes | Capgo 4+ | 0.3 KB / 1 call + listeners | low |
| 15 | Appflow snapshot id | N | — | yes | yes | LU 0.x, Cap 8 | 0.2 KB | medium; product EOL 2027-12-31 |
| 16 | Proxy-URL unwrap + sanitise in `resource_timing` | E | — | yes | yes | Cap 6+ | ~0.1 KB | none |
| 17 | `traceparent` on `fetch`/XHR (allow-listed) | N | yes | yes | yes | — | ~0.3 KB | **high if not allow-listed** (CORS preflight breaks requests) |
| 18 | Angular CD tick cost (`ɵTracingService`) | N | yes | yes | yes | Ng 19.2 | 0.4 KB / 0 / 2× `now()` per tick | **high** (private) |
| 19 | Installed-plugin inventory (`PluginHeaders`) | N | — | yes | yes | Cap 3+ | 0.1 KB once | low |
| 20 | Error dedupe vs `provideBrowserGlobalErrorListeners` | E | yes | yes | yes | Ng 20 | ~0.1 KB | none |

## Notable constraints and surprises

- **`screen.duration` is probably dead in production.** It is a bubble-phase listener on non-bubbling Ionic events (§3.1). Tests mask it by dispatching on the listener target.
- **`http.request` misses `HttpClient` on Angular 16–21** (XHR default). Fetch default arrived only in 22.0.0 (verified in npm tarballs 20.3.0 / 21.0.0 / 22.0.0).
- **`CapacitorHttp` GETs go through a localhost proxy (Capacitor 6+).** Resource Timing records `/_capacitor_http_interceptor_?u=<real URL>`, and `perf-observer.ts` ships it unsanitised.
- **Wrapping `Capacitor.fromNative` misses Android** (results go through a private `returnResult`). Wrap `nativePromise`/`nativeCallback` instead. Exclude the SDK's own plugin and transport calls or the SDK reports itself.
- **Listening for back-button the "obvious" way changes app behaviour.** Any `App` `backButton` listener, or a `document` `backbutton` listener (rewritten by `native-bridge.js`), disables Android's default WebView back.
- **Android renderer death kills the app by default under Capacitor.** We already catch the resulting crash but can't say why. The public `WebViewListener` fixes attribution at near-zero cost.
- **iOS WebContent crash is a silent reload with no supported plugin hook.** It looks like a mysterious "app restarted at the same screen" with a new JS session. Today it would show up as a fresh `page_load` mid-session.
- **Angular prod builds expose no supported per-component or per-tick profiler.** `enableProfiling` is a no-op without `ngDevMode`. `ɵTracingService` (19.2+) is the only prod-grade hook, and it is private.
- **Zoneless (default 21+) silences `NgZone.onStable` / `onMicrotaskEmpty`.** Design nothing on zone stability.
- **OTA updates don't change `app.version` or script URLs.** Release identity and source-map keys must come from the web bundle. `WebView.getServerBasePath()` is the updater-agnostic primitive. A build-time injected release id is better still.
- **Appflow is EOL 2027-12-31.** Only `@capacitor/live-updates` 0.x exists for Capacitor (peer `>=8`) and it has no current-snapshot getter. Capgo is the integration worth building.
- **`traceparent` without an allow-list will break customer APIs** when `CapacitorHttp` is off (the default): the WebView origin is `capacitor://localhost` / `https://localhost`, so the header forces a preflight.
- **Ionic 9 is current** (Angular 18–22, Capacitor ≥ 7, iOS 16+). The ticket's "Ionic 7 vs 8" framing is one major behind.

## Open questions

- Device confirmation that `IonicLifecycleCapture` never fires on a real Ionic 8/9 app (quick HITL run; this repo has no `demo/`, so use any Ionic starter).
- iOS `CapacitorHttp` proxy path: are request headers (e.g. `traceparent`) forwarded? Not checked in `WebViewAssetHandler.swift`.
- On Android, does an unhandled `onRenderProcessGone` surface as a JVM exception or a native abort (which of our handlers records it)?
- Does `ɵTracingService.snapshot()` get called in zone-based (non-zoneless) Angular 19.2–22 apps, or only when the zoneless scheduler is active?
- Capacitor version that introduced `WebViewListener.onRenderProcessGone`, and whether `WebView.getServerBasePath` exists before 5.0 (our peer floor is 5, so only the former matters).
- Capgo bundle path layout under `getServerBasePath()` (does it contain `bundle.id`?). This decides whether the plugin-agnostic id can be mapped back to a Capgo bundle without calling Capgo.

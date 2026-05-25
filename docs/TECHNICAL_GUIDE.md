# edge-rum Technical Guide

**Audience:** Ionic / Angular / Capacitor developers integrating the `@nathanclaire/rum` SDK.

**SDK version:** 3.2.0 · **Wire-contract version:** 3.1.0

This document is the authoritative technical reference for what the SDK captures, when it captures it, what each event contains, and how to configure or disable each piece. Companion docs:

- [Quick start](./quick-start.md) — five-minute wire-up
- [Config reference](./config-reference.md) — every option on `EdgeRumConfig`
- [Backend integration](./backend-integration.md) — wire contract, auth, CORS
- [Architecture decisions](./decisions.md) — why things are the way they are
- [Privacy](./privacy.md) — what is collected and what isn't
- [`payload-schema.json`](./payload-schema.json) — machine-readable wire contract

---

## Table of contents

1. [Mental model in one minute](#1-mental-model-in-one-minute)
2. [Automatic capture catalog](#2-automatic-capture-catalog)
3. [Manual API surface](#3-manual-api-surface)
4. [Session lifecycle](#4-session-lifecycle)
5. [User journey tracking](#5-user-journey-tracking)
6. [Native crash bridge (Capacitor)](#6-native-crash-bridge-capacitor)
7. [Sampling semantics](#7-sampling-semantics)
8. [Reliability — offline queue, retry, breadcrumbs, health](#8-reliability)
9. [Wire contract summary](#9-wire-contract-summary)
10. [Identity attribute reference](#10-identity-attribute-reference)
11. [Configuration matrix](#11-configuration-matrix)
12. [Privacy considerations](#12-privacy-considerations)
13. [Debugging missing data](#13-debugging-missing-data)
14. [Version compatibility](#14-version-compatibility)

---

## 1. Mental model in one minute

The SDK is a Real User Monitoring (RUM) library for Ionic/Angular/Capacitor apps. It captures user behaviour, errors, performance, and native crashes, and ships them as JSON to a proprietary backend (the EdgeTelemetryProcessor).

The default install (`EdgeRumModule.forRoot({...})`) is **automatic and opinionated**:

- Every navigation, screen exit, HTTP request, click, web vital, long task, resource fetch, error, console.error, and lifecycle transition is captured with zero further wiring.
- Sessions start, persist across 30 minutes of inactivity, and are finalized on background / app close / rotation.
- A 20-item breadcrumb buffer of user actions is attached to every crash for forensic context.
- Native crashes (iOS NSException, iOS hangs, Android Throwable, Android ANR, Android NDK signals) are captured on next launch via a Capacitor plugin.
- Sampled-out sessions still emit `app.crash`, `session.started`, `session.finalized`, `user.profile.update` — sampling never silently swallows critical signal.

Everything is namespaced under `attributes.*` per the wire contract. The outer envelope is `{ type: "telemetry_batch", timestamp, batch_size, events }`. Wire contract is JSON-only, no Protobuf, no compression.

If you're integrating this SDK for the first time, read [Quick start](./quick-start.md) first, then come back here for the deep dive.

---

## 2. Automatic capture catalog

Every event/metric the SDK emits without you having to call anything. Each row links to the source file so you can see exactly what fires it.

### 2.1 Events (eventName-routed)

| Event | When it fires | Source | Notable attributes |
|---|---|---|---|
| `session.started` | At SDK init, on foreground after 30-min idle (rotation), or after a prior background within timeout (resume) | `EdgeRum.init()` + `packages/capacitor/src/LifecycleCapture.ts` | `session.start_reason: 'init' \| 'resumed' \| 'rotation_timeout'` |
| `session.finalized` | On every background, app close (pagehide/beforeunload), and on rotation boundary. Flushes immediately. | `packages/capacitor/src/LifecycleCapture.ts` | `session.end_reason`, `session.duration_ms`, `session.visited_screens`, `session.screen_count`, `session.event_count`, `session.metric_count`, `session.journey_truncated`, `sdk.error_count` |
| `navigation` | On every Angular Router navigation end | `packages/angular/src/RouterCapture.ts` | `navigation.from_screen`, `navigation.to_screen`, `navigation.method: 'push' \| 'pop' \| 'replace' \| 'initial' \| 'cancel'`, `navigation.route_type: 'main_flow' \| 'deeplink' \| 'modal' \| 'settings'`, `navigation.has_arguments`, `navigation.timestamp` |
| `screen.duration` | On every Ionic `ionViewDidLeave` | `packages/angular/src/IonicLifecycleCapture.ts` | `screen.name` (uses current route, not tag name), `screen.duration_ms`, `screen.exit_method` (carries the actual navigation method), `screen.timestamp` |
| `http.request` | On every `fetch()` / XHR completion (or abort) | `packages/core/src/instrumentation/requests.ts` | `http.url` (sanitized), `http.method`, `http.status_code`, `http.duration_ms`, `http.success`, `http.timestamp` |
| `app.crash` | Window error, unhandled promise rejection, `console.error/warn` (configurable), manual `captureError()`, **or any native crash from the Capacitor plugin** | `packages/core/src/instrumentation/errors.ts` + `packages/capacitor/src/NativeCrashCapture.ts` | `exception_type`, `message`, `stacktrace`, `is_fatal`, `handled`, `error_context: 'screen:<route>'`, `cause`, `runtime: 'webview' \| 'native'`, `crash.breadcrumbs` (JSON-string), `crash.breadcrumb_count`, plus native fields when applicable |
| `user.profile.update` | On every `EdgeRum.identify()` call | `EdgeRum.identify()` | `user.profile_version` (monotonic), `user.profile_updated_at`, plus only the fields the caller actually passed |
| `user.interaction` | On every `click` at the document level (capture phase, passive); 50ms dedup | `packages/core/src/instrumentation/interactions.ts` | `interaction.type: 'click'`, `interaction.target_tag`, `interaction.target_id?`, `interaction.target_class?`, `interaction.target_role?`, `interaction.screen`, `interaction.timestamp`. **Never** captures inner text. |
| `app_lifecycle` | Foreground / background | `packages/capacitor/src/LifecycleCapture.ts` | `lifecycle.event: 'foreground' \| 'background'`, `lifecycle.cold_start_ms` (first foreground only) |
| `page_load` | Once per browser session, after `window.load` | `packages/core/src/instrumentation/pageload.ts` | `page.ttfb_ms`, `page.dom_content_loaded_ms`, `page.load_duration_ms`, `page.resource_count`, `page.route` |
| `network_change` | Capacitor Network plugin connection-type change | `packages/capacitor/src/NetworkCapture.ts` | `network.connected`, `network.type`, `network.previous_type` |
| `custom_event` | `EdgeRum.track('name', {...})` | `EdgeRum.track()` | `event.name`, plus consumer-supplied attrs |

### 2.2 Metrics (top-level `metricName` + `value`)

Metrics use a different item shape — `{ type: 'metric', metricName, value, timestamp, attributes }` — and never have an `eventName`. The backend has a separate dispatch for them.

| metricName | When it fires | Source | Notable attributes |
|---|---|---|---|
| `LCP` / `FCP` / `INP` / `CLS` / `TTFB` (Web Vitals) | Once per page per metric, when the browser settles the value | `packages/core/src/instrumentation/vitals.ts` | `metric.unit: 'ms' \| 'score'`, `metric.rating: 'good' \| 'needs-improvement' \| 'poor'`, `metric.screen` |
| `long_task` | Every `PerformanceObserver` `longtask` entry (>50ms main-thread block) | `packages/core/src/instrumentation/perf-observer.ts` | `metric.unit: 'ms'`, `metric.name`, `metric.screen` |
| `resource_timing` | Every `PerformanceObserver` `resource` entry (image, css, font, script, fetch) except the SDK's own endpoint | `packages/core/src/instrumentation/perf-observer.ts` | `metric.unit: 'ms'`, `metric.resource_name`, `metric.resource_type`, `metric.transfer_size?`, `metric.screen` |
| `<custom>` | `EdgeRum.time('name')` → `.end({...})` | `EdgeRum.time()` | `metric.unit: 'ms'`, plus consumer-supplied attrs |

### 2.3 What's NOT automatic

These need explicit consumer calls:

- `EdgeRum.identify({ name, email, phone })` — attach user details (still anonymous before this)
- `EdgeRum.captureError(err, context)` — log a handled error as `app.crash` with `cause: 'ManualCapture'`
- `EdgeRum.track(name, attrs)` — emit a `custom_event`
- `EdgeRum.time(name).end(attrs)` — emit a custom metric
- `EdgeRum.trackScreen(name, attrs)` — emit a `navigation` event manually (also closes the previous screen with a `screen.duration` if one was open)

---

## 3. Manual API surface

```typescript
EdgeRum.init(config: EdgeRumConfig): void
EdgeRum.identify(user: { name?: string; email?: string; phone?: string }): void
EdgeRum.track(name: string, attributes?: EventAttributes): void
EdgeRum.trackScreen(name: string, attributes?: EventAttributes): void
EdgeRum.time(name: string): RumTimer        // returns { end(attributes?): void }
EdgeRum.captureError(error: Error, context?: Record<string, unknown>): void
EdgeRum.disable(): void
EdgeRum.enable(): void
EdgeRum.getSessionId(): string
```

In Angular, the same surface is available via DI as `EdgeRumService`:
```typescript
constructor(private rum: EdgeRumService) {}
this.rum.track('checkout_started', { amount: 49.99 });
this.rum.trackScreen('CheckoutModal');
this.rum.identify({ name: 'Alice' });
```

### 3.1 EdgeRum.identify behaviour

- The SDK keeps a stable, persistent **anonymous** `user.id` from the very first launch (stored in localStorage). `identify()` does **not** change it — it attaches name/email/phone via context attributes.
- Each call emits exactly one `user.profile.update` event with the monotonically-incrementing `user.profile_version` and `user.profile_updated_at`. Only the fields you passed are echoed — passing `{name: 'Alice'}` then `{email: 'x@y.com'}` emits two events; the second one does **not** re-emit `user.name`.
- Pass `null` to clear a field: `identify({ email: null })` deletes the stored email.
- Backend uses these events to populate `rum_users`.

### 3.2 EdgeRum.trackScreen behaviour

- Emits a `navigation` event with `to_screen: name`, `method: 'push'` (overridable), `from_screen` auto-derived from the journey list.
- Also emits a `screen.duration` event for the **previous** screen (the one set by the last `trackScreen` call), computing `Date.now() - enteredAt`, with `exit_method: 'push'` (or whatever you passed).
- Updates the SDK's "current route" so `metric.screen`, `interaction.screen`, `error_context`, and breadcrumbs all see the new screen.
- The final active screen at the end of a session is auto-flushed into `session.finalized` so no duration is lost.
- **Do not** mix `trackScreen()` with Angular Router + IonicLifecycleCapture — both paths emit `screen.duration` and will double-count. Choose one source per screen.

### 3.3 EdgeRum.captureError behaviour

- Emits `app.crash` with `cause: 'ManualCapture'`, `handled: true`, `is_fatal: false`.
- Includes the breadcrumb snapshot.
- Goes through the immediate-flush path — does NOT respect the 5s flush interval.
- `context` argument is shallow-flattened — only primitive values survive, nested objects are dropped silently.

### 3.4 EdgeRum.disable() / enable()

- `disable()` halts capture, clears the offline queue, and stops the pipeline timer.
- `enable()` restarts the pipeline and re-tries the offline queue. It does NOT emit a fresh `session.started`.
- Disable does NOT emit a `session.finalized: disabled` — that's an explicit out-of-scope decision documented in ADR-022.

---

## 4. Session lifecycle

A session is a logical container identified by `session.id`. The SDK manages its lifecycle automatically.

### 4.1 Session id format

```
session_{Date.now()}_{16hexchars}_{platform}
e.g.  session_1716624000000_a8b9c2d176b4ce41_ios
```

Platform is one of `ios | android | web`, detected synchronously at init via `window.Capacitor.getPlatform()` (falls back to `'web'`).

### 4.2 Lifecycle states

```
   ┌─────────────────────────────────────────────────────────────┐
   │                                                             │
init┴─────► session.started ──┐                                   │
{start_reason:'init'}         │                                   │
                              ▼                                   │
                       ┌─── ACTIVE ───┐                            │
                       │              │                            │
                       │   events     │                            │
                       │   metrics    │                            │
                       │   interactions                            │
                       │              │                            │
            background │              │ foreground (idle<30min)    │
                       ▼              │                            │
                  session.finalized   │                            │
                {end_reason:'backgrounded'} ─► session.started     │
                       │              ◄── {start_reason:'resumed'} │
                       │                                            │
            >30min idle│                                            │
                       ▼                                            │
                  session rotates ───────► session.started          │
                  (new session.id)         {start_reason:'rotation_timeout'}
                       │                                            │
            pagehide   │                                            │
                       ▼                                            │
                  session.finalized                                 │
                  {end_reason:'app_closed'} via beacon              │
                                                                    │
                                                                    └──────────► EOF
```

### 4.3 What's on session.finalized

Every `session.finalized` carries a snapshot of the journey + counters captured *before* the finalize event itself:

```jsonc
{
  "type": "event",
  "eventName": "session.finalized",
  "timestamp": "2026-05-25T09:05:12.000Z",
  "attributes": {
    "session.id": "session_171...x9y8z7w6deadbeef_ios",
    "session.start_time": "2026-05-25T09:00:00.000Z",
    "session.sequence": 11,
    "session.duration_ms": 312000,
    "session.ended_at": "2026-05-25T09:05:12.000Z",
    "session.end_reason": "backgrounded",
    "session.visited_screens": "/login,/tabs/home,/tabs/profile",
    "session.screen_count": 3,
    "session.event_count": 11,
    "session.metric_count": 2,
    "session.journey_truncated": false,
    "sdk.error_count": 0,
    // ...plus all identity context attrs
  }
}
```

`session.event_count` does NOT include the `session.finalized` event itself — the snapshot is taken before the finalize push.

### 4.4 First session detection

The SDK persists a cross-launch counter in localStorage (`edge_rum_total_sessions`). Every event in the very first session carries `session.is_first_session: true` and `session.total_sessions: 1`. On the second launch (or after rotation), `is_first_session: false` and `total_sessions: 2`. Counter survives across SDK upgrades; clearing site data resets it.

### 4.5 Persisted state across launches

| Key | Where | What for |
|---|---|---|
| `edge_rum_anon_uid` | localStorage (sessionStorage fallback) | Stable anonymous `user.id` across sessions |
| `edge_rum_device_id` | localStorage | Stable `device.id` across sessions |
| `edge_rum_total_sessions` | localStorage | Cross-launch counter for `total_sessions` / `is_first_session` |
| `edge_rum_q` | localStorage | Offline queue (JSON-serialised batch payload strings) |
| `<Caches>/edge-rum/pending-crashes.json` (iOS) | Disk | Native crash records from previous launch, replayed at next init |
| `<filesDir>/edge-rum/jvm/<id>.json` (Android) | Disk | JVM Throwables persisted by the uncaught handler |
| `<filesDir>/edge-rum/anr/<id>.json` (Android) | Disk | ANR records |
| `<filesDir>/edge-rum/ndk-records.bin` (Android) | Disk | NDK signal-handler binary records (async-signal-safe write path) |

The native crash files are read on next launch by the Capacitor plugin and emitted as `app.crash` events with `runtime: 'native'`.

---

## 5. User journey tracking

The SDK records the screen-by-screen path the user took, and reports it on `session.finalized`.

### 5.1 What gets tracked

Every `navigation` event's `navigation.to_screen` value is appended to an in-memory list on the active session. On `session.finalized`, the list is serialised as a comma-separated string in `session.visited_screens`.

Sources that feed the journey:
- Angular Router (`RouterCapture`) → emits `navigation` events on every router end → journey appended
- `EdgeRum.trackScreen(name)` → emits `navigation` events manually → journey appended

The list is **capped at 200 entries**. Once the cap is hit, further visits set `session.journey_truncated: true` and are dropped; the first 200 are preserved so the journey's start (usually the most important debugging signal) is intact.

### 5.2 Screen name canonicalization

To keep `visited_screens` and `screen.duration` joinable on the backend, `IonicLifecycleCapture` resolves the screen name from the SDK's current route (set by `RouterCapture` after each navigation). The Ionic component tag name (e.g. `app-product-detail`) is only used as a fallback when no route has fired yet (pre-first-navigation).

This means in practice:
- `screen.duration.screen.name` = `'/tabs/profile'` (route path)
- `session.visited_screens` = `'/tabs/products,/tabs/profile'`
- Both are joinable to the same backend dimension.

### 5.3 What "screen" means with trackScreen

When you call `EdgeRum.trackScreen('CheckoutModal')`:
1. If a previous `trackScreen` had set an active screen, a `screen.duration` event is emitted for it (`Date.now() - enteredAt`, `exit_method: 'push'`).
2. A `navigation` event is emitted with `to_screen: 'CheckoutModal'`.
3. The SDK's current route updates to `'CheckoutModal'` so subsequent vitals, errors, and breadcrumbs attribute to it.
4. The active screen tracker remembers `CheckoutModal` for the next `trackScreen` call.

If the session ends with an active screen still open (e.g. background → finalize), the active screen is auto-flushed as a final `screen.duration` event before `session.finalized` is emitted (`exit_method: 'finalize'`).

---

## 6. Native crash bridge (Capacitor)

When you bootstrap the Capacitor capture (`startCapacitorCapture()`, called automatically by `EdgeRumModule`), the SDK registers a Capacitor plugin called `EdgeRumCrash` that installs native crash handlers.

### 6.1 What's captured per platform

| Platform | Class | Mechanism | Runs in process |
|---|---|---|---|
| iOS | Mach signal (SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT) | PLCrashReporter | Dying process; record persisted; replayed on next launch |
| iOS | NSException uncaught | PLCrashReporter | Same |
| iOS | Swift uncaught error (bridged) | PLCrashReporter | Same |
| iOS | Main-thread hang > 5s (configurable) | DispatchSourceTimer heartbeat | Live; record persisted; replayed on next launch or next batch |
| Android | Java/Kotlin uncaught `Throwable` | `Thread.setDefaultUncaughtExceptionHandler` | Dying process; chained to previous handler so OS still shows crash dialog |
| Android | ANR (>5s main-thread block, configurable) | Background-thread watchdog | Live |
| Android | NDK signal (SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT) | C++ `sigaction` async-signal-safe handler | Dying process; binary record written via `write(2)` only |

### 6.2 Persistence & replay model

The plugin writes crash records to the app's cache directory. On the **next** `EdgeRum.init()` (next launch), the JS bridge:

1. Calls `plugin.install()` — re-arms the handlers.
2. Calls `plugin.fetchPending()` — gets the list of records persisted last launch.
3. Emits each as an `app.crash` event via `Collector.recordEvent('app.crash', ...)`.
4. Calls `plugin.markHandled({ ids })` — deletes the consumed records.

Records carry `runtime: 'native'` and a set of namespaced attributes:

```jsonc
{
  "cause": "NativeCrash",                  // or "ANR" | "Hang"
  "runtime": "native",
  "exception_type": "EXC_BAD_ACCESS",       // platform-specific
  "message": "Mach signal SIGSEGV at 0x0",
  "stacktrace": "...",
  "is_fatal": true,
  "handled": false,
  "error_context": "screen:/checkout",      // last known route, mirrored from JS to native
  "crash.id": "<uuid>",
  "crash.captured_at": "2026-05-25T09:04:01.000Z",   // when the crash actually happened
  "crash.platform": "ios",                  // or "android"
  "crash.platform_version": "17.4",
  "crash.signal": "SIGSEGV",                // only on signal-class crashes
  "crash.thread": "main",
  "crash.symbolication": "required",        // backend needs symbols (NDK only)
  "anr.duration_ms": 6500                   // only on ANR/Hang
}
```

`error_context` carries the last route the JS bridge had relayed to native (via `plugin.setLastScreen({screen})`, throttled to 1/sec). This is how a crash that destroys the webview still carries the screen the user was on.

### 6.3 Symbolication

NDK signal-handler records carry **raw addresses** (`0x7b8c0e1200` per frame). Stack walking happens async-signal-safely via `_Unwind_Backtrace`. The `crash.symbolication: 'required'` flag tells the backend that symbolication against uploaded `.so` debug symbols is needed.

iOS records from PLCrashReporter are pre-symbolicated via `PLCrashReportTextFormatter` (`crash.symbolication: 'symbolicated'`).

Android JVM crashes (`Thread.setDefaultUncaughtExceptionHandler`) carry the standard `Throwable.printStackTrace()` text, fully symbolicated by the JVM.

### 6.4 What's not captured

- Native iOS background-task hangs (BGTaskScheduler integration is out of scope).
- Native iOS WatchKit / extension crashes (separate process).
- Crashes that happen **before** PLCrashReporter / the JVM handler is installed (i.e., during early `AppDelegate`/`Application.onCreate` startup).
- Crashes during the signal handler itself (we install `SA_RESETHAND` so re-raising the signal hits the default handler).

---

## 7. Sampling semantics

`sampleRate` is a number between `0` and `1` (default `1.0`).

### 7.1 Per-session, not per-event

The decision is made **once per session** at `SessionManager` construction (and re-rolled on session rotation). A sampled-in session emits everything; a sampled-out session emits **nothing** except the critical event allowlist below. This avoids fractional journeys where some navigations are captured and others aren't.

### 7.2 Critical events bypass sampling

These four events are always emitted regardless of `sampleRate`:

- `app.crash` — never lose a crash to sampling
- `session.started` — backend needs the boundary
- `session.finalized` — backend needs the boundary + journey
- `user.profile.update` — `rum_users` rollup needs identification

Other events (`navigation`, `screen.duration`, `http.request`, `user.interaction`, `app_lifecycle`, metrics, etc.) are sampled.

### 7.3 Counter semantics under sampling

`session.event_count` / `session.metric_count` reflect what was **actually emitted** — not what would have been emitted at `sampleRate: 1`. In a sampled-out session you'll see `event_count` = roughly 4 (`session.started` + a couple of crashes + `session.finalized`) and `metric_count` = 0.

`session.is_first_session` / `total_sessions` always emit — they live in context attributes and ride along on every event regardless of sampling.

---

## 8. Reliability

### 8.1 Offline queue

If a `transport.send()` fails (network down, 5xx, CORS hiccup), the batch is serialised and pushed to localStorage under `edge_rum_q`. Cap is `maxQueueSize` (default 200). Overflow drops oldest.

Queue drains automatically on:
- Every successful live `transport.send()` (opportunistic drain — was previously only on three trigger events; now self-healing)
- `NetworkCapture` reconnect
- `LifecycleCapture` foreground
- `EdgeRum.enable()` after `disable()`

### 8.2 Retry schedule

```
Attempt 1: immediate
Attempt 2: +2 s
Attempt 3: +8 s
Attempt 4: +30 s → push to offline queue
```

Retryable status codes: `0` (network error), `429` (respects `Retry-After`), `503`.
Non-retryable status codes: any other 4xx — discard with a debug warning.

### 8.3 Immediate-flush events

These bypass the 5s batch interval and trigger a flush as soon as they're recorded:

- `app.crash`
- `session.finalized`

The flush is async; on `pagehide` we additionally call `Pipeline.freeze()` to prevent the async flush from racing the synchronous beacon drain, and use `navigator.sendBeacon` (or sync XHR on iOS where sendBeacon is unreliable) to ship the buffered events before the process dies.

### 8.4 Breadcrumbs

The Collector maintains a ring buffer of the last 20 user actions. Every event (except `app.crash` itself) pushes a breadcrumb with `{ ts, type, name }`. On every `app.crash` emission, the snapshot is serialised as `crash.breadcrumbs` (JSON-string) on the crash event with `crash.breadcrumb_count`.

This is a documented exception to the flat-primitives rule — the backend parses the string.

### 8.5 Health monitoring

A singleton `HealthMonitor` counts internal SDK errors (any time a capture path catches an exception). In `debug: true` mode they're logged to `console.warn` with a scope tag (`vitals.recordMetric`, `errors.dispose`, etc.). On every `session.finalized`, `sdk.error_count` carries the per-session total. Useful for spotting silent breakage like a failed `@capacitor/device` import.

---

## 9. Wire contract summary

### 9.1 Envelope

```jsonc
POST /collector/telemetry
Content-Type: application/json
X-API-Key: edge_your_key_here

{
  "type": "telemetry_batch",
  "timestamp": "<ISO 8601 batch flush time>",
  "location": "Nairobi/Kenya",            // optional
  "batch_size": 3,                         // integer; equals events.length
  "events": [ ...event and metric items ]
}
```

### 9.2 Event item shape

```jsonc
{
  "type": "event",
  "eventName": "navigation",
  "timestamp": "<ISO 8601>",
  "attributes": { /* flat primitives only */ }
}
```

### 9.3 Metric item shape

```jsonc
{
  "type": "metric",
  "metricName": "FCP",
  "value": 670,
  "timestamp": "<ISO 8601>",
  "attributes": { /* flat primitives only */ }
}
```

### 9.4 Flat-primitive rule

`attributes` values are always `string | number | boolean`. Nested objects / arrays are forbidden. Flatten with dot-notation at the capture layer. The TypeScript constraint `Record<string, string | number | boolean>` enforces this; a CI assertion verifies in every test payload.

**One documented exception:** `crash.breadcrumbs` is a JSON-string. The backend parses it.

### 9.5 Backend dispatch

The processor's `event_processor.py` branches on:
- `item.type === 'metric'` → metric pipeline
- `item.eventName === 'navigation'` → `rum_navigation_events`
- `item.eventName === 'screen.duration'` → `rum_screen_durations`
- `item.eventName === 'http.request'` → `rum_http_requests`
- `item.eventName === 'app.crash'` → `rum_crashes`
- `item.eventName === 'user.profile.update'` → `rum_users`
- `item.eventName === 'session.started'` → `rum_sessions` (insert/upsert)
- `item.eventName === 'session.finalized'` → `rum_sessions` (close row + journey)
- Anything else → catch-all (`performance_events`)

`user.interaction`, `long_task`, `resource_timing` (new in 3.2.0) ride the catch-all today until the processor adds dedicated handlers.

---

## 10. Identity attribute reference

These attributes are merged into **every** event via the `ContextManager`. The collector drops events missing the **required** identity attrs.

| Key | Type | Required? | Source |
|---|---|---|---|
| `app.name` | string | optional | `config.appName` |
| `app.version` | string | optional | `config.appVersion` |
| `app.package_name` | string | required | `config.appPackage` |
| `app.build_number` | string | optional (omitted when unknown — never empty) | `config.appBuild` OR Capacitor `@capacitor/app` async load |
| `app.environment` | enum | optional, default `'production'` | `config.environment` |
| `device.id` | string | required | Generated at first launch, persisted |
| `device.platform` | enum (`ios/android/web`) | required | Capacitor `Device.getInfo()` |
| `device.model`, `device.manufacturer`, `device.os`, `device.platform_version`, `device.isVirtual`, `device.screenWidth`, `device.screenHeight`, `device.pixelRatio`, `device.batteryLevel`, `device.batteryCharging` | various primitives | optional | DeviceContext |
| `network.connected` | boolean | optional | NetworkCapture |
| `network.type`, `network.effectiveType`, `network.downlinkMbps` | enum / number | optional | NetworkCapture |
| `session.id` | string | required | SessionManager |
| `session.start_time` | ISO 8601 | required | SessionManager |
| `session.sequence` | int | optional | SessionManager — increments on each successful send |
| `session.is_first_session` | boolean | always | SessionManager — first launch detection |
| `session.total_sessions` | int (≥1) | always | SessionManager — cross-launch counter |
| `user.id` | string | required | SDK-owned anonymous id |
| `user.name`, `user.email`, `user.phone` | string | optional | `EdgeRum.identify()` |
| `sdk.version` | string | always | `'3.2.0'` |
| `sdk.contract_version` | string | always | `'3.1.0'` — wire-contract version |
| `sdk.platform` | string | always | `'ionic-angular-capacitor'` |

### 10.1 ID formats

```
device.id:   "device_{Date.now()}_{16hexchars}_{platform}"
             e.g. "device_1716624000000_a8b9c2d176b4ce41_ios"

session.id:  "session_{Date.now()}_{16hexchars}_{platform}"
             e.g. "session_1716624000000_x9y8z7w6deadbeef_ios"

user.id:     "user_{Date.now()}_{16hexchars}"
             e.g. "user_1716624000000_abcd1234deadbeef"
```

The random segment uses 16 hex chars (64 bits of entropy from `crypto.getRandomValues`) — wide enough to make collisions impossible at any realistic scale.

---

## 11. Configuration matrix

Grouped by capture domain. Every option is on `EdgeRumConfig`. Full per-option docs in [config-reference.md](./config-reference.md).

### 11.1 Required

| Option | Type | Notes |
|---|---|---|
| `apiKey` | string | Must start with `'edge_'`. Sent as `X-API-Key`. |
| `endpoint` | string | Full URL to your collector. |

### 11.2 Identity

| Option | Default | Effect |
|---|---|---|
| `appName` | undefined | Sets `app.name` |
| `appVersion` | undefined | Sets `app.version` |
| `appPackage` | undefined | Sets `app.package_name` |
| `appBuild` | undefined | Sets `app.build_number` synchronously. On native, Capacitor bootstrap also resolves it asynchronously. |
| `environment` | `'production'` | Sets `app.environment` |
| `location` | undefined | Sets envelope `location` (e.g. `"Nairobi/Kenya"`) |

### 11.3 Sampling

| Option | Default | Effect |
|---|---|---|
| `sampleRate` | `1.0` | Decided once per session. Critical events bypass. |

### 11.4 Capture toggles

| Option | Default | Effect |
|---|---|---|
| `captureConsoleErrors` | `true` | Wraps `console.error`/`warn` to emit `app.crash` events |
| `captureNativeCrashes` | `true` | Registers the Capacitor `EdgeRumCrash` plugin |
| `enableAnrDetection` | `true` (Android) | Starts main-thread ANR watchdog |
| `enableHangDetection` | `true` (iOS) | Starts main-thread hang watchdog |
| `anrTimeoutMs` | `5000` | ANR threshold |
| `hangTimeoutMs` | `5000` | iOS hang threshold |

### 11.5 Network

| Option | Default | Effect |
|---|---|---|
| `ignoreUrls` | `[]` | URLs matching (string substring or regex) are excluded from HTTP capture |
| `sanitizeUrl` | strips `token`/`email`/`phone`/`key`/`secret`/`password`/`auth` query params | Custom URL rewriter |

### 11.6 Transport

| Option | Default | Effect |
|---|---|---|
| `flushIntervalMs` | `5000` | How often to flush the buffer |
| `batchSize` | `30` | Max events per batch |
| `maxQueueSize` | `200` | Offline-queue cap (FIFO overflow) |
| `deferFlush` | `false` | If true, pipeline buffers until `Pipeline.markReady()` is called (used internally by Capacitor bootstrap to wait for device context) |

### 11.7 Debug

| Option | Default | Effect |
|---|---|---|
| `debug` | `false` | Logs every send + every internal error via `console.warn`. Redacts API key. |

---

## 12. Privacy considerations

The SDK is designed not to capture personally-identifying data by default. See [privacy.md](./privacy.md) for the formal policy. Key points:

- **No inner text from clicks.** `user.interaction` only carries tag/id/class/role. The decision is fixed; we don't even read `textContent`. If you need to track which button label was clicked, add a `data-event-name` attribute and capture it via `EdgeRum.track()`.
- **URL sanitization.** `sanitizeUrl` strips PII-prone query params by default. Override for stricter scrubbing (e.g., path segments containing customer IDs).
- **Anonymous user ID by default.** The SDK never automatically identifies users. `EdgeRum.identify()` requires you to explicitly pass details, and you should pass opaque IDs not PII when possible.
- **Crash breadcrumbs.** The breadcrumb ring contains the last 20 events. Sensitive data inside event attributes (e.g., a URL with a token) will leak unless you've configured `sanitizeUrl` correctly.
- **Native crash dumps.** PLCrashReporter on iOS captures register state; the textual dump format the SDK ships does NOT include memory contents, but stack symbols may include framework function names that hint at app structure.

---

## 13. Debugging missing data

### 13.1 Turn on debug mode

```typescript
EdgeRumModule.forRoot({
  apiKey: 'edge_...',
  endpoint: '...',
  debug: true,
});
```

You'll see in the console:
- `[edge-rum] initialized { endpoint: '...' }` on first init
- `[edge-rum] recordEvent <name> <attrs>` on each emit
- `[edge-rum] send failed, queuing offline ...` on transport failures
- `[edge-rum] <scope>: <error>` for internal SDK errors (via HealthMonitor)

### 13.2 Inspect a payload manually

In your dev tools network tab, filter for the collector endpoint. The payload is plain JSON — search for `eventName: "navigation"` to confirm router capture is wired, etc.

### 13.3 Common gotchas

| Symptom | Likely cause | Fix |
|---|---|---|
| No `navigation` events | Angular Router not imported in the same module that imports `EdgeRumModule`, or routes have empty paths | Check Router DI works in `RouterCapture` constructor |
| `screen.duration` carries tag names (e.g., `'app-product'`) instead of routes | Pre-first-navigation fallback firing | Ensure `RouterCapture` is wired and at least one navigation fires before `IonicLifecycleCapture` sees an exit |
| `app.crash` has empty `stacktrace` | Browser minified the bundle and `error.stack` is just one line | Ship source maps + enable backend symbolication |
| `user.interaction` never fires | Document is unavailable (SSR, headless test) | Skip — this is correct behavior |
| Native crashes never arrive | Capacitor plugin not loaded | `cd ios && pod install` + `./gradlew assembleDebug`. Confirm the `EdgeRumCrash` plugin is in the Capacitor manifest. |
| `session.event_count` is unexpectedly low | Session sampled out — only critical events were emitted | Check `sampleRate` and `session.is_first_session` to confirm |
| `sdk.error_count > 0` on session.finalized | Some capture path threw silently | Enable `debug: true` and reproduce — internal errors are logged with scope tags |
| `device.id` regenerated unexpectedly | Storage cleared (private mode, uninstall, user reset), OR upgraded from v3.0.x (ID format widened from 8 → 16 hex) | Expected behaviour for both cases |

### 13.4 Verify session lifecycle is firing

For a smoke test, open dev tools, foreground the app, watch the network tab:

1. Should see immediately: a batch with `session.started { start_reason: 'init' }`.
2. Tap a button or navigate: batch should include `user.interaction` and `navigation`.
3. Switch to another tab (background): batch with `session.finalized { end_reason: 'backgrounded', visited_screens: '...' }` should fire.
4. Switch back within 30 min: batch with `session.started { start_reason: 'resumed' }`.

---

## 14. Version compatibility

| SDK version | Wire contract | Backend version it works with |
|---|---|---|
| 3.0.0 | 3.0.0 (`telemetry_batch` envelope, `http.request`, `screen.duration`) | EdgeTelemetryProcessor with the v3.0 event_processor dispatch |
| 3.0.1 | 3.0.0 | Same — `sdk.contract_version` not yet emitted, backend can't tell them apart |
| 3.1.0 | 3.1.0 (adds `user.interaction`, `long_task`, `resource_timing`, `crash.breadcrumbs`, `sdk.error_count`, 16-hex IDs, `sdk.contract_version`) | Backend needs to accept new event names; unknown ones land in catch-all (non-breaking) |
| 3.2.0 | 3.1.0 | Same wire contract. Adds native crash bridge (NSException, signals, Throwable, NDK, ANR, Hang) — all under existing `app.crash` shape, just new `cause` values + native `crash.*` attrs |

**`sdk.contract_version`** is on every event from 3.1.0+. The backend can log "unknown contract" once per session if it doesn't recognize the value, helping detect skew between SDK and processor deployments.

### 14.1 Upgrading from 3.0.x to 3.2.0

No breaking JS API changes. New config flags are all optional, all default to on. ID format change (8 → 16 hex chars) invalidates persisted device/user IDs on first launch — they regenerate fresh. Backend must accept the new ID regex.

Native crash bridge requires consumer to run `pod install` (iOS) and rebuild Android (`./gradlew assembleDebug`) once. Disable the bridge with `captureNativeCrashes: false` if you can't yet.

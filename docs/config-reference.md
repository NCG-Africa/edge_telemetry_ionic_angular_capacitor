# Configuration reference

Every option accepted by `EdgeRum.init()` and `EdgeRumModule.forRoot()`.

```typescript
interface EdgeRumConfig {
  // --- Required ---
  apiKey: string;
  endpoint: string;

  // --- Identity ---
  appName?: string;
  appVersion?: string;
  appPackage?: string;
  appBuild?: string;
  environment?: 'production' | 'staging' | 'development';
  location?: string;

  // --- Sampling ---
  sampleRate?: number;

  // --- Capture toggles ---
  captureConsoleErrors?: boolean;
  captureNativeCrashes?: boolean;
  enableAnrDetection?: boolean;
  enableHangDetection?: boolean;
  anrTimeoutMs?: number;
  hangTimeoutMs?: number;
  awaitNativeInstall?: boolean;
  captureFrames?: boolean;
  captureAllFrames?: boolean;
  frameSlowThresholdMs?: number;
  captureMemory?: boolean;
  memorySamplingIntervalMs?: number;

  // --- Network ---
  ignoreUrls?: (string | RegExp)[];
  sanitizeUrl?: (url: string) => string;

  // --- Transport ---
  flushIntervalMs?: number;
  batchSize?: number;
  maxQueueSize?: number;
  deferFlush?: boolean;

  // --- Debug ---
  debug?: boolean;
}
```

---

## Required

### `apiKey` (required)

- Type: `string`
- Must start with `edge_`

Authenticates every request. Sent as the `X-API-Key` header. Treat it as a secret in production builds — do not commit it to source control. Use environment variables or a build-time secret injector.

### `endpoint` (required)

- Type: `string`

Full URL your data is sent to. Must include scheme + path. No default — the SDK refuses to initialise without one.

---

## Identity

### `appName`

- Type: `string`
- Default: `undefined`

Human-readable application name. Attached to every event as `app.name`.

### `appVersion`

- Type: `string`
- Default: `undefined`

Application version (e.g. `"2.1.0"`). Attached as `app.version`. Set this from your build pipeline so you can correlate issues to a release.

### `appPackage`

- Type: `string`
- Default: `undefined`

Bundle / package identifier (e.g. `"com.yourco.app"`). Attached as `app.package_name`. **The backend requires this** — events without it are typically dropped or land in catch-all rollups.

### `appBuild`

- Type: `string`
- Default: `undefined`

Build number (e.g. `"210"`). Attached as `app.build_number`. **Two ways the SDK gets it:**

1. **Synchronously** from this config field at init time. Use this when your build pipeline can inject the value.
2. **Asynchronously** from Capacitor's `@capacitor/app` plugin on native platforms — fires after init completes. Events recorded in the gap get back-filled with the resolved value at flush time.

If neither is available, the field is **omitted** entirely from events (not sent as an empty string). The backend dedupes app versions on `(package_name, version, build_number)`, so omission > empty string.

### `environment`

- Type: `'production' | 'staging' | 'development'`
- Default: `'production'`

Deployment context. Attached as `app.environment`.

### `location`

- Type: `string`
- Default: `undefined`

Optional per-install location string (e.g. `"Nairobi/Kenya"`). Set this if you want to tag every batch with a geographic / data-center context. Attached to the outer envelope as `location`, not to individual event attributes.

---

## Sampling

### `sampleRate`

- Type: `number` (clamped to `[0.0, 1.0]`)
- Default: `1.0`

**Per-session, not per-event.** The decision is made once at the start of every session (and re-rolled on rotation). A sampled-in session emits everything; a sampled-out session emits **only** the critical event allowlist:

- `app.crash` (always)
- `session.started` (always)
- `session.finalized` (always)
- `user.profile.update` (always)

Other events (`navigation`, `screen.duration`, `http.request`, `user.interaction`, metrics, etc.) are dropped in a sampled-out session.

This prevents fractional journeys where some navigations are captured and others aren't. See [TECHNICAL_GUIDE.md § 7](./TECHNICAL_GUIDE.md#7-sampling-semantics) for the full semantics.

---

## Capture toggles

### `captureConsoleErrors`

- Type: `boolean`
- Default: `true`

Wraps `console.error` and `console.warn` so each call emits an `app.crash` event with `cause: 'ConsoleError'` or `'ConsoleWarn'`, `is_fatal: false`, `handled: true`. The original `console.error`/`warn` still fires so devtools continue to work.

Set to `false` if you log a lot of warnings as a normal part of your app's behaviour (otherwise they become noisy crash events).

### `captureNativeCrashes`

- Type: `boolean`
- Default: `true`

Registers the Capacitor `EdgeRumCrash` plugin on native platforms. Set to `false` if you have a separate crash reporter installed (e.g., Crashlytics, Sentry) and don't want a second pipeline.

No effect on web — the bridge only runs when `Capacitor.isNativePlatform()` is true.

### `enableAnrDetection`

- Type: `boolean`
- Default: `true` (Android only)

Starts a background-thread watchdog that posts a heartbeat to the main `Looper` every `anrTimeoutMs / 2`. If the heartbeat isn't picked up within `anrTimeoutMs`, captures the main-thread stack and writes an `app.crash` record with `cause: 'ANR'`, `is_fatal: false`, `handled: true`, `anr.duration_ms`.

### `enableHangDetection`

- Type: `boolean`
- Default: `true` (iOS only)

Starts a `DispatchSourceTimer`-based heartbeat that detects main-thread hangs > `hangTimeoutMs`. Writes an `app.crash` with `cause: 'Hang'`, `is_fatal: false`, `handled: true`.

### `anrTimeoutMs`

- Type: `number`
- Default: `5000`

Main-thread blocked threshold before an ANR is recorded.

### `hangTimeoutMs`

- Type: `number`
- Default: `5000`

iOS equivalent of `anrTimeoutMs`.

### `awaitNativeInstall`

- Type: `boolean`
- Default: `false`
- Platform: native (iOS / Android), no effect on web

When `false` (the default), the native crash bridge's `plugin.install()`
and `plugin.fetchPending()` run on the next idle tick
(`requestIdleCallback` / `setTimeout(0)` fallback) instead of blocking
the bootstrap critical path. This typically saves **50–150 ms** of
cold-start time on modern devices, up to **~200 ms** on older devices
and first-install scenarios.

The screen-relay listener that feeds `error_context` is wired
**synchronously** regardless of this flag, so crashes happening during
the deferred-install gap still record the correct screen — they just
get replayed a few hundred ms later (in batch 2 of the next session
instead of batch 1).

Set to `true` only if you absolutely need the native signal handlers
armed before any other code in the app can run. The window is typically
<50 ms and crashes during it are exceedingly rare; the default is
recommended.

### `captureFrames`

- Type: `boolean`
- Default: `true`

Emits `frame_render_time` metric items measuring WebView (and native) frame intervals.

| Platform | Source |
|---|---|
| Web / WebView | `requestAnimationFrame` deltas with the build slice derived from overlapping `PerformanceObserver` `longtask` entries |
| iOS native | `CADisplayLink` on the main thread |
| Android native | `Choreographer.FrameCallback` on the main looper |

By default only **slow** frames (interval ≥ `frameSlowThresholdMs`) are emitted, so idle screens cost nothing. `frame_dropped` is `true` when the interval is ≥ 2× the slow threshold (≥ one missed vsync at 60Hz). Both `frame_build_duration` and `frame_raster_duration` are always numbers — never null.

Set to `false` to disable frame capture entirely (web *and* native).

### `captureAllFrames`

- Type: `boolean`
- Default: `false`

Debug-only escape hatch. When `true`, emits a `frame_render_time` event for **every** measured frame regardless of duration — useful when investigating jank but **very** noisy at 60fps. Leave `false` in production.

### `frameSlowThresholdMs`

- Type: `number`
- Default: `16.67` (one frame at 60Hz)

Frames whose total interval is shorter than this value are skipped (when `captureAllFrames` is the default `false`). Raise it to `20` or `25` for tighter signal; lower it (e.g. `12`) on 90Hz / 120Hz devices to flag frames that miss the higher refresh budget.

### `captureMemory`

- Type: `boolean`
- Default: `true`

Emits `memory_usage` metric items with the process resident-set value in MB and a coarse pressure level.

| Platform | Source | `memory_type` |
|---|---|---|
| Web / WebView | `performance.memory.usedJSHeapSize` (Chromium only) | `heap` |
| iOS native | `mach_task_basic_info.resident_size` + `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE` | `rss` |
| Android native | `Debug.MemoryInfo.totalPss` + `ComponentCallbacks2.onTrimMemory` | `pss` |

Samples are emitted every `memorySamplingIntervalMs` plus on every memory-pressure callback and every foreground/background transition. `memory_pressure_level` is omitted when no platform signal is available (web).

### `memorySamplingIntervalMs`

- Type: `number`
- Default: `10000` (10 s)
- Minimum: `1000`

How often to take a periodic memory sample. The pressure-driven and lifecycle samples are independent of this — they always fire.

---

## Network

### `ignoreUrls`

- Type: `(string | RegExp)[]`
- Default: `[]`

URLs matching any entry are excluded from HTTP capture. Strings match as substrings; regexes are tested against the full URL.

```typescript
ignoreUrls: [
  'https://example.com/health',
  /\.png$/,
  /googletagmanager/,
]
```

The SDK's own collector endpoint is **always** ignored (no self-capture loop).

### `sanitizeUrl`

- Type: `(url: string) => string`
- Default: strips `token`, `email`, `phone`, `key`, `secret`, `password`, `auth` query params

Rewrites every captured URL before it's stored as `http.url`. Use this to remove customer identifiers from paths:

```typescript
sanitizeUrl: (url) => url.replace(/\/users\/\d+/, '/users/:id'),
```

The default function is applied first; if you supply your own, it **replaces** the default. To layer custom logic on top of the default, manually call the default scrubber or reproduce its behaviour in your function.

---

## Transport

### `flushIntervalMs`

- Type: `number`
- Default: `5000`

How often (in milliseconds) the SDK ships buffered events. `app.crash` and `session.finalized` are sent immediately regardless of this value.

### `batchSize`

- Type: `number`
- Default: `30`

Maximum number of events per outgoing batch. Matches the Android SDK default so you see consistent batch sizes across platforms.

### `maxQueueSize`

- Type: `number`
- Default: `200`

Maximum number of pending batches buffered to localStorage while the device is offline or sends are failing. When the cap is reached, the oldest pending batch is dropped first (FIFO).

### `deferFlush`

- Type: `boolean`
- Default: `false`

If true, the pipeline buffers events until `Pipeline.markReady()` is called explicitly. The Capacitor bootstrap uses this internally to delay the first flush until device context (model, manufacturer, OS, etc.) and the native build number have been resolved — so the very first batch contains the full context instead of a barebones identity slice.

You don't normally need to set this. Leave at `false` unless you're wiring `startCapacitorCapture()` manually.

---

## Debug

### `debug`

- Type: `boolean`
- Default: `false`

Logs every `recordEvent`, every `recordMetric`, every transport send/failure, and every internal SDK error via `console.warn` with `[edge-rum]` scope tags. The API key is redacted to `edge_****` in all log output.

Never enable in production — adds 5–10× console noise and incurs string formatting cost on every event.

---

## Example — full configuration

```typescript
EdgeRum.init({
  // Required
  apiKey: process.env.EDGE_RUM_API_KEY!,
  endpoint: 'https://rum.yourco.internal/collector/telemetry',

  // Identity
  appName: 'Acme Mobile',
  appVersion: '4.2.1',
  appPackage: 'com.acme.mobile',
  appBuild: process.env.BUILD_NUMBER,
  environment: 'production',
  location: 'eu-west-1',

  // Sampling — 25% of sessions get the full firehose; the rest only emit critical events
  sampleRate: 0.25,

  // Capture toggles
  captureConsoleErrors: true,
  captureNativeCrashes: true,
  enableAnrDetection: true,
  enableHangDetection: true,
  anrTimeoutMs: 5000,
  hangTimeoutMs: 5000,
  captureFrames: true,
  frameSlowThresholdMs: 16.67,
  captureMemory: true,
  memorySamplingIntervalMs: 10_000,

  // Network filtering
  ignoreUrls: [/\/health$/, 'https://maps.googleapis.com'],
  sanitizeUrl: (url) => url.replace(/\/users\/\d+/, '/users/:id'),

  // Transport tuning
  flushIntervalMs: 10_000,
  batchSize: 50,
  maxQueueSize: 500,

  debug: false,
});
```

# CLAUDE.md — edge-rum SDK Development Guide

This file is the source of truth for AI-assisted development on this project.
Read it completely before writing any code, generating any files, or making any suggestions.

---

## What this project is

`edge-rum` is a Real User Monitoring SDK for **Ionic Angular Capacitor** apps. It captures
performance data, errors, network requests, and user interactions, then ships them as JSON
to a proprietary backend — the EdgeTelemetryProcessor — that also receives data from the
Edge Telemetry Android SDK.

**Payload compatibility is a hard requirement.** The wire format conforms to the
EdgeTelemetryProcessor contract documented in `docs/payload-schema.json`. The same Kafka
processor handles both platforms.

---

## The two rules that override everything else

### Rule 1 — The terminology firewall

The following words and identifiers **must never appear** in:
- Any file under `packages/*/src/index.ts`
- Any public type declaration (`.d.ts` output files)
- Any documentation, README, or comment visible to consumers
- Any error message thrown to consumers
- Any `console.*` output in production mode

**Banned in public surface:**
```
opentelemetry / otel / otlp
span / trace / tracer
TracerProvider / SpanProcessor / SpanExporter
MeterProvider / LoggerProvider
instrumentation / telemetry
metric / metrics (in API names — fine in docs as "performance data")
```

**Allowed internally** (inside `internal/`, `instrumentation/`, `transport/`):
use any name that makes the code clear. The firewall is the `index.ts` export boundary only.

**Consumer vocabulary:**

| Instead of... | Say... |
|---|---|
| span / trace | event |
| instrumentation | capture |
| telemetry | performance data |
| emit / record a span | record an event |
| metrics | performance data |
| OTLP / collector | (never mentioned) |

### Rule 2 — JSON only, always

All data sent to the backend must be:
- `Content-Type: application/json`
- `JSON.stringify(payload)` as the body
- No compression, no binary encoding, no Protobuf

---

## EdgeTelemetryProcessor contract — read this before touching PayloadBuilder

The web SDK must produce payloads matching the EdgeTelemetryProcessor wire contract. The
backend collector tier resolves `tenant_id` from the API key, so the SDK does NOT send it.

### Envelope structure

```json
{
  "type": "telemetry_batch",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "location": "Nairobi/Kenya",
  "batch_size": 3,
  "events": [ ...events ]
}
```

- `type`: always the string `"telemetry_batch"`.
- `timestamp`: ISO 8601 string of the batch flush time. Use `new Date().toISOString()`. Never Unix ms.
- `location`: optional per-app/install string (City/Country). Set via `EdgeRumConfig.location`.
- `batch_size`: integer equal to `events.length` (optional on the wire, but included for parity).
- `events`: array of event and metric items.

### Required identity attributes on every event

The collector drops events missing any of these. PayloadBuilder merges them in from
`ContextManager` so every emitted event carries them:

- `app.package_name`, `app.name`, `app.version`, `app.build_number`
- `device.id`, `device.platform`
- `user.id` (plus optional `user.name`, `user.email`, `user.phone`)
- `session.id`, `session.start_time`
- `network.type` (optional)

### Individual event structure

```json
{
  "type": "event",
  "eventName": "navigation",
  "timestamp": "2024-01-15T10:30:00.123Z",
  "attributes": {
    "app.name": "MyApp",
    "app.version": "1.0.0",
    "app.package_name": "com.example.myapp",
    "app.build_number": "42",
    "app.environment": "production",
    "device.id": "device_1704067200000_a8b9c2d1_web",
    "device.platform": "web",
    "device.model": "iPhone 15 Pro",
    "device.manufacturer": "Apple",
    "device.os": "ios",
    "device.platform_version": "17.4",
    "device.isVirtual": false,
    "device.screenWidth": 390,
    "device.screenHeight": 844,
    "device.pixelRatio": 3.0,
    "device.batteryLevel": 0.82,
    "device.batteryCharging": false,
    "network.type": "wifi",
    "network.effectiveType": "4g",
    "network.downlinkMbps": 24.5,
    "session.id": "session_1704067200000_x9y8z7w6_web",
    "session.start_time": "2024-01-15T10:25:00.000Z",
    "session.sequence": 42,
    "user.id": "user_1704067200000_abcd1234",
    "sdk.version": "3.0.0",
    "sdk.platform": "ionic-angular-capacitor",
    "...eventSpecificAttributes": "..."
  }
}
```

**Wire contract pinned facts:**

| Field | Value | Notes |
|---|---|---|
| Outer batch `type` | `"telemetry_batch"` | Never the old `"batch"` value |
| Per-event `type` | `"event"` (or `"metric"`) | Discriminator |
| `eventName` | see mapping table below | Backend routes by this |
| `timestamp` | ISO 8601 string | `new Date().toISOString()` |
| `attributes` | flat key-value object | Primitives only, no nesting |
| `app.package_name` | in `attributes` | NOT `app.package` |
| `session.start_time` | in `attributes` | NOT `session.startTime` |
| `device.platform_version` | in `attributes` | NOT `device.osVersion` |
| Auth header | `X-API-Key` | |

### ID formats

```
device.id:  "device_{timestampMs}_{16hexchars}_{platform}"
            e.g. "device_1704067200000_a8b9c2d176b4ce41_web"

session.id: "session_{timestampMs}_{16hexchars}_{platform}"
            e.g. "session_1704067200000_x9y8z7w6deadbeef_web"

user.id:    "user_{timestampMs}_{16hexchars}"
            e.g. "user_1704067200000_abcd1234deadbeef"
            (SDK-owned anonymous ID; EdgeRum.identify() does not change it)
```

Format note (v3.1.0): the random segment widened from 8 to 16 hex chars (64 bits of entropy) to eliminate birthday-collision risk at scale. Existing persisted IDs in `localStorage` are invalidated by the new regex on next launch — fresh IDs generate transparently.

---

## eventName values

The backend dispatches each event by `eventName`. Currently shipped names:

| Web SDK concept | `eventName` value | Where emitted |
|---|---|---|
| Angular route change (entry hop) | `navigation` | `packages/angular/src/RouterCapture.ts` |
| Ionic screen exit (dwell time) | `screen.duration` | `packages/angular/src/IonicLifecycleCapture.ts` |
| HTTP request | `http.request` | `packages/core/src/instrumentation/requests.ts` |
| Web Vital (LCP, INP, etc.) | (`metric` item, `metricName` = `"LCP"`/`"FCP"`/...) | `packages/core/src/instrumentation/vitals.ts` |
| JS / unhandled error | `app.crash` | `packages/core/src/instrumentation/errors.ts` (includes `crash.breadcrumbs` JSON-string of last 20 actions) |
| Console.error / .warn | `app.crash` (cause=ConsoleError/Warn) | `packages/core/src/instrumentation/errors.ts` (opt-out via `captureConsoleErrors: false`) |
| **iOS native crash** (NSException / Mach signal SIGSEGV-class) | `app.crash` (cause=NativeCrash, runtime=native) | `packages/capacitor/ios/` (PLCrashReporter wrapper) — replayed on next launch |
| **iOS main-thread hang** | `app.crash` (cause=Hang, runtime=native) | `packages/capacitor/ios/Plugin/HangDetector.swift` |
| **Android JVM throwable** | `app.crash` (cause=NativeCrash, runtime=native) | `packages/capacitor/android/.../JvmCrashHandler.kt` (Thread.setDefaultUncaughtExceptionHandler) |
| **Android NDK signal** | `app.crash` (cause=NativeCrash, runtime=native, symbolication=required) | `packages/capacitor/android/src/main/cpp/native-crash.cpp` |
| **Android ANR** | `app.crash` (cause=ANR, runtime=native) | `packages/capacitor/android/.../AnrWatchdog.kt` |
| Click / tap | `user.interaction` | `packages/core/src/instrumentation/interactions.ts` |
| Long task (PerformanceObserver longtask) | (`metric` item, metricName = `"long_task"`) | `packages/core/src/instrumentation/perf-observer.ts` |
| Resource timing (PerformanceObserver resource) | (`metric` item, metricName = `"resource_timing"`) | `packages/core/src/instrumentation/perf-observer.ts` |
| Session begins (init / resume / rotation) | `session.started` | `EdgeRum.init()` + `packages/capacitor/src/LifecycleCapture.ts` |
| Session ends (background / app close) | `session.finalized` | `packages/capacitor/src/LifecycleCapture.ts` (immediate-flush; carries journey summary + `sdk.error_count`) |
| `EdgeRum.identify()` user attach | `user.profile.update` | `EdgeRum.identify()` |
| Custom `EdgeRum.track()` | `custom_event` | `EdgeRum.track()` |
| Custom `EdgeRum.time()` | (`metric` item) | `EdgeRum.time()` — uses the `metric` item shape, not `eventName` |
| App foreground / background | `app_lifecycle` | `packages/capacitor/src/LifecycleCapture.ts` |
| Page load timing | `page_load` | `packages/core/src/instrumentation/pageload.ts` |
| Network connectivity change | `network_change` | `packages/capacitor/src/NetworkCapture.ts` |

> The `network_request` and `screen_view` names from earlier SDK versions are **gone**.
> Backend silently drops anything else.

---

## Complete payload example — what edge-rum sends

```jsonc
// POST /collector/telemetry
// Content-Type: application/json
// X-API-Key: edge_your_api_key_here

{
  "type": "telemetry_batch",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "location": "Nairobi/Kenya",
  "batch_size": 3,
  "events": [

    // ── navigation (entry hop in user journey) ──────────────────────────
    {
      "type": "event",
      "eventName": "navigation",
      "timestamp": "2024-01-15T10:30:00.123Z",
      "attributes": {
        "app.name": "MyApp",
        "app.version": "2.1.0",
        "app.package_name": "com.yourco.app",
        "app.build_number": "42",
        "app.environment": "production",
        "device.id": "device_1704067200000_a8b9c2d1_web",
        "device.platform": "ios",
        "device.model": "iPhone 15 Pro",
        "device.platform_version": "17.4",
        "network.type": "wifi",
        "session.id": "session_1704067200000_x9y8z7w6_web",
        "session.start_time": "2024-01-15T10:25:00.000Z",
        "session.sequence": 1,
        "user.id": "user_1704067200000_abcd1234",
        "sdk.version": "3.0.0",
        "sdk.platform": "ionic-angular-capacitor",
        "navigation.from_screen": "/tabs/products",
        "navigation.to_screen": "/tabs/profile",
        "navigation.method": "push",
        "navigation.route_type": "main_flow",
        "navigation.has_arguments": false,
        "navigation.timestamp": "2024-01-15T10:30:00.123Z"
      }
    },

    // ── screen.duration (on screen exit, full dwell time) ───────────────
    {
      "type": "event",
      "eventName": "screen.duration",
      "timestamp": "2024-01-15T10:30:04.456Z",
      "attributes": {
        "app.name": "MyApp",
        "app.package_name": "com.yourco.app",
        "app.build_number": "42",
        "device.id": "device_1704067200000_a8b9c2d1_web",
        "device.platform": "ios",
        "network.type": "wifi",
        "session.id": "session_1704067200000_x9y8z7w6_web",
        "session.start_time": "2024-01-15T10:25:00.000Z",
        "user.id": "user_1704067200000_abcd1234",
        "sdk.version": "3.0.0",
        "sdk.platform": "ionic-angular-capacitor",
        "screen.name": "/tabs/profile",
        "screen.duration_ms": 4331,
        "screen.exit_method": "navigate",
        "screen.timestamp": "2024-01-15T10:30:04.456Z"
      }
    },

    // ── http.request (fetch capture) ────────────────────────────────────
    {
      "type": "event",
      "eventName": "http.request",
      "timestamp": "2024-01-15T10:30:00.456Z",
      "attributes": {
        "app.name": "MyApp",
        "app.package_name": "com.yourco.app",
        "app.build_number": "42",
        "device.id": "device_1704067200000_a8b9c2d1_web",
        "device.platform": "ios",
        "network.type": "wifi",
        "session.id": "session_1704067200000_x9y8z7w6_web",
        "session.start_time": "2024-01-15T10:25:00.000Z",
        "user.id": "user_1704067200000_abcd1234",
        "sdk.version": "3.0.0",
        "sdk.platform": "ionic-angular-capacitor",
        "http.url": "https://api.example.com/products",
        "http.method": "GET",
        "http.status_code": 200,
        "http.duration_ms": 342,
        "http.success": true,
        "http.timestamp": "2024-01-15T10:30:00.456Z"
      }
    }
  ]
}
```

Web Vitals are emitted as `metric` items with top-level `metricName` (`"LCP"` /
`"FCP"` / `"CLS"` / `"INP"` / `"TTFB"`) and numeric `value`. Example:

```jsonc
{
  "type": "metric",
  "metricName": "FCP",
  "value": 670,
  "timestamp": "2024-01-15T10:30:00.500Z",
  "attributes": {
    "metric.unit": "ms",
    "metric.rating": "good",
    "metric.screen": "/tabs/profile",
    "app.name": "MyApp",
    "device.id": "device_1704067200000_a8b9c2d1_web",
    "session.id": "session_1704067200000_x9y8z7w6_web",
    "user.id": "user_1704067200000_abcd1234",
    "sdk.version": "3.0.1",
    "sdk.platform": "ionic-angular-capacitor"
  }
}
```

Other event shapes (`app.crash`, `user.profile.update`, `custom_event`,
`app_lifecycle`, `page_load`, `network_change`, and `metric` items from
`EdgeRum.time()`) follow the same envelope and identity attribute rules. See
`docs/payload-schema.json` for the authoritative attribute lists.

---

## PayloadBuilder implementation notes

Because every event carries the full context (app, device, session, user) as flat attributes,
`PayloadBuilder` must:

1. Maintain a `contextAttributes` object in `ContextManager` — updated once on init and
   on any change (user identify, network change, etc.).
2. On each event, call `{ ...contextAttributes, ...eventAttributes }` to merge flat.
3. Build the outer envelope:
   `{ type: "telemetry_batch", timestamp: new Date().toISOString(), location?, batch_size, events }`.
   `location` is sourced from `EdgeRumConfig.location` and threaded through the `Pipeline`.
4. Never nest objects inside `attributes` — all values must be primitives
   (`string | number | boolean`). Flatten any nested data with dot-notation keys.

**Flattening example:**
```typescript
// Internal representation (fine to use internally)
const deviceInfo = { model: "iPhone 15 Pro", os: "ios", screen: { width: 390 } };

// What goes into attributes (must be flat)
{
  "device.model": "iPhone 15 Pro",
  "device.os": "ios",
  "device.screenWidth": 390          // flattened, camelCase
}
```

---

## Repository structure

```
edge-rum/
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── index.ts              ← PUBLIC BOUNDARY only
│   │       ├── EdgeRum.ts
│   │       ├── types.ts              ← public types only
│   │       ├── session/
│   │       │   ├── SessionManager.ts
│   │       │   └── SessionIdGenerator.ts
│   │       ├── internal/             ← OTel wiring. NEVER re-exported.
│   │       │   ├── pipeline.ts
│   │       │   ├── collector.ts      ← recordEvent() — single internal entrypoint
│   │       │   └── context.ts
│   │       ├── instrumentation/      ← capture hooks
│   │       │   ├── requests.ts
│   │       │   ├── errors.ts
│   │       │   ├── vitals.ts
│   │       │   └── pageload.ts
│   │       ├── transport/
│   │       │   ├── JsonExporter.ts
│   │       │   ├── PayloadBuilder.ts ← builds Android-compatible envelope
│   │       │   └── RetryTransport.ts
│   │       └── queue/
│   │           └── OfflineQueue.ts
│   ├── angular/
│   │   └── src/
│   │       ├── index.ts
│   │       ├── EdgeRumModule.ts
│   │       ├── EdgeRumService.ts
│   │       ├── RouterCapture.ts
│   │       ├── ErrorCapture.ts
│   │       └── IonicLifecycleCapture.ts
│   └── capacitor/
│       └── src/
│           ├── index.ts
│           ├── DeviceContext.ts
│           ├── NetworkCapture.ts
│           └── LifecycleCapture.ts
├── demo/
├── docs/
│   ├── payload-schema.json          ← authoritative wire contract
│   ├── decisions.md
│   └── terminology.md
├── CLAUDE.md
├── PLAN.md
└── THIRD_PARTY_LICENSES
```

---

## Public API surface

### `EdgeRumConfig`
```typescript
interface EdgeRumConfig {
  apiKey: string;                    // sent as X-API-Key header — must start with "edge_"
  endpoint: string;                   // required — no default, must be provided by the developer
  appName?: string;                  // used as app.name in all events
  appVersion?: string;               // used as app.version
  appPackage?: string;               // used as app.package_name (e.g. "com.yourco.app")
  appBuild?: string;                 // used as app.build_number — omitted entirely when unset
  environment?: 'production' | 'staging' | 'development';
  location?: string;                 // batch envelope location, e.g. "Nairobi/Kenya"
  sampleRate?: number;               // 0.0–1.0, default 1.0
  ignoreUrls?: (string | RegExp)[];
  maxQueueSize?: number;             // default 200
  flushIntervalMs?: number;          // default 5000
  batchSize?: number;                // max events per payload, default 30
  sanitizeUrl?: (url: string) => string;
  captureConsoleErrors?: boolean;    // default true; wraps console.error/warn → app.crash
  captureNativeCrashes?: boolean;    // default true; registers the Capacitor native bridge
  enableAnrDetection?: boolean;      // default true on Android
  enableHangDetection?: boolean;     // default true on iOS
  anrTimeoutMs?: number;             // default 5000
  hangTimeoutMs?: number;            // default 5000
  debug?: boolean;
}
```

### `EdgeRum` static methods
```typescript
EdgeRum.init(config: EdgeRumConfig): void
EdgeRum.identify(user: UserContext): void
EdgeRum.track(name: string, attributes?: Record<string, string | number | boolean>): void
EdgeRum.trackScreen(name: string, attributes?: Record<string, string | number | boolean>): void  // manual screen tracking; emits a `navigation` event
EdgeRum.time(name: string): RumTimer           // returns { end(attributes?): void }
EdgeRum.captureError(error: Error, context?: Record<string, unknown>): void
EdgeRum.disable(): void
EdgeRum.enable(): void
EdgeRum.getSessionId(): string
```

---

## TypeScript conventions

- `strict: true` — no `any`, no non-null assertions without explaining why.
- Use `unknown` over `any` when the type is genuinely unknown.
- All public interfaces in `packages/core/src/types.ts`.
- No `enum` — use `const` objects + `as const` + derived union types.
- All async functions return `Promise<void>` or `Promise<T>`.
- Attributes objects passed to `PayloadBuilder` must always be
  `Record<string, string | number | boolean>` — never nested objects. Enforce this with a
  type-level constraint and flatten at the instrumentation layer, not in `PayloadBuilder`.

---

## Testing conventions

### Required payload assertions on every transport test
```typescript
const payload = JSON.parse(body);

// Envelope shape
expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);   // ISO 8601
expect(payload.type).toBe('telemetry_batch');
expect(payload).not.toHaveProperty('device_id');
expect(payload.events).toBeInstanceOf(Array);

// Each event
payload.events.forEach(event => {
  expect(event.type).toBe('event');
  expect(event.eventName).toBeDefined();
  expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(event.attributes).toBeDefined();

  // Context always present
  expect(event.attributes['session.id']).toMatch(/^session_/);
  expect(event.attributes['device.id']).toMatch(/^device_/);
  expect(event.attributes['sdk.platform']).toBe('ionic-angular-capacitor');

  // No OTel field names anywhere
  expect(JSON.stringify(event)).not.toContain('traceId');
  expect(JSON.stringify(event)).not.toContain('spanId');
  expect(JSON.stringify(event)).not.toContain('resourceSpans');
  expect(JSON.stringify(event)).not.toContain('opentelemetry');

  // No nested objects in attributes
  Object.values(event.attributes).forEach(v => {
    expect(typeof v).toMatch(/^(string|number|boolean)$/);
  });
});

// Auth header
expect(headers['x-api-key']).toMatch(/^edge_/);
expect(headers['content-type']).toBe('application/json');
```

---

## Error handling conventions

### Thrown to consumers
```typescript
throw new Error('edge-rum: apiKey is required');
throw new Error('edge-rum: apiKey must start with "edge_"');
throw new Error('edge-rum: init() must be called before identify()');
```

### Internal errors — catch and swallow
```typescript
try {
  await RetryTransport.send(payload);
} catch (err) {
  if (config.debug) console.warn('[edge-rum] send failed', err);
  OfflineQueue.push(JSON.stringify(payload));
}
```

---

## Capacitor conventions

Every Capacitor plugin call must be guarded:
```typescript
if (!Capacitor.isNativePlatform()) {
  return webFallback();
}
const { Device } = await import('@capacitor/device');
return Device.getInfo();
```

---

## Angular conventions

- Never import `@angular/*` in `packages/core/`.
- `APP_INITIALIZER` boots the SDK before the first component renders.
- Route normalisation is mandatory: capture `/products/:id` not `/products/9876`.
- `EdgeRumService` is a thin DI wrapper — no logic beyond delegating to `EdgeRum.*`.

---

## Session and ID rules

```
device.id:   "device_{Date.now()}_{16hexchars}_{platform}"
session.id:  "session_{Date.now()}_{16hexchars}_{platform}"
user.id:     "user_{Date.now()}_{16hexchars}"
```

Generate the 16 hex chars using `crypto.getRandomValues` or `Math.random().toString(16)`.
On native, `platform` = `ios` or `android` (from `Device.getInfo()`). On web = `web`.

Session expires after 30 minutes of inactivity. New session on next foreground.
`session.sequence` increments on every successfully sent payload. Stored in `SessionManager`.
`session.startTime` = ISO 8601 string of when the session began.

---

## Transport rules

```
Auth:         X-API-Key: <apiKey>         (matches Android SDK header)
Content-Type: application/json
Endpoint:     POST /collector/telemetry   (same path as Android SDK)
```

Retry schedule (same logic as Android SDK's exponential backoff):
```
Attempt 1: immediate
Attempt 2: 2s
Attempt 3: 8s
Attempt 4: 30s → push to OfflineQueue
```

Retry on: `0`, `429` (respect `Retry-After`), `503`.
Never retry: other `4xx`. Discard + warn in debug mode.
Errors flush immediately. All other events follow `flushIntervalMs` (default 5000ms).
Batch max size: `batchSize` (default 30, matches Android default).

---

## Offline queue rules

- Storage key: `edge_rum_q`
- Values: JSON-serialised array of complete batch payload strings.
- Cap: `maxQueueSize` (default 200). Overflow drops oldest (FIFO).
- Flush: sequential. Success removes. Failure keeps.
- Triggers: network reconnect, app foreground, `EdgeRum.enable()`.
- `EdgeRum.disable()` clears queue entirely.

---

## Bundle rules

- `noExternal: [/@opentelemetry\/.*/]` — OTel always bundled, never a peer dep.
- `sideEffects: false` on all packages.
- `@capacitor/*` and `@angular/*` are peer deps — never bundled.
- Size limits: core < 90KB gzipped, full stack < 200KB gzipped.

---

## CI checks (all must pass before merge)

1. `pnpm lint`
2. `pnpm type-check`
3. `pnpm test`
4. `pnpm build`
5. Terminology check: `grep -rE "TracerProvider|SpanProcessor|MeterProvider|otlp" dist/**/*.d.ts` → must find nothing
6. Attribute flatness check: assert no object/array values in `attributes` in any test payload
7. `pnpm size`
8. `pnpm test:integration`

---

## When in doubt checklist

1. Public surface? → Apply Rule 1 (terminology firewall).
2. Touches the wire? → Apply Rule 2 (JSON only, `telemetry_batch` envelope).
3. Adding a new `eventName`? → Confirm with the backend team and update `docs/payload-schema.json`.
4. Attributes nested? → Flatten them. Always primitives only.
5. Timestamp field? → ISO 8601 string, never Unix ms.
6. Auth header? → `X-API-Key`, never `Authorization: Bearer`.
7. Involves Capacitor? → Guard with `isNativePlatform()`.
8. Angular-specific? → Goes in `packages/angular/`, not `packages/core/`.
9. New event field? → Update `docs/payload-schema.json` first.
10. Non-obvious choice? → Write an entry in `docs/decisions.md`.

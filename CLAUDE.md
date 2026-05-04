# CLAUDE.md — edge-rum SDK Development Guide

This file is the source of truth for AI-assisted development on this project.
Read it completely before writing any code, generating any files, or making any suggestions.

---

## What this project is

`edge-rum` is a Real User Monitoring SDK for **Ionic Angular Capacitor** apps. It captures
performance data, errors, network requests, and user interactions, then ships them as JSON
to a proprietary backend — the **same backend** that already receives data from the
Edge Telemetry Android SDK.

**Payload compatibility is a hard requirement.** The wire format is aligned to the Android
SDK's batch envelope so the same Kafka processor, storage tables, and dashboards handle
both platforms without branching.

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

## Android SDK alignment — read this before touching PayloadBuilder

The backend already processes payloads from the Android SDK. The web SDK **must produce
the same envelope structure** so the Kafka processor handles both without changes.

### Envelope structure (matches collector server)

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "type": "batch",
  "device_id": "device_1704067200000_a8b9c2d1_web",
  "events": [ ...events ]
}
```

- `timestamp`: ISO 8601 string of the batch flush time — **NOT Unix ms**. Use `new Date().toISOString()`.
- `type`: always the string `"batch"` — never changes.
- `device_id`: device identifier extracted from `events[0].attributes["device.id"]`. Required by the collector server.
- `events`: array of event objects.

### Individual event structure (matches Android exactly)

Every event in the array:

```json
{
  "type": "event",
  "eventName": "screen_view",
  "timestamp": "2024-01-15T10:30:00Z",
  "attributes": {
    "app.name": "MyApp",
    "app.version": "1.0.0",
    "app.package": "com.example.myapp",
    "app.environment": "production",
    "device.id": "device_1704067200000_a8b9c2d1_web",
    "device.platform": "web",
    "device.model": "iPhone 15 Pro",
    "device.manufacturer": "Apple",
    "device.os": "ios",
    "device.osVersion": "17.4",
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
    "session.startTime": "2024-01-15T10:25:00Z",
    "session.sequence": 42,
    "user.id": "user_1704067200000_abcd1234",
    "sdk.version": "1.0.0",
    "sdk.platform": "ionic-angular-capacitor",
    ...eventSpecificAttributes
  }
}
```

**Critical alignment points:**

| Field | Android SDK | Web SDK (edge-rum) | Notes |
|---|---|---|---|
| Outer `type` | `"event"` | `"event"` | Always `"event"` for every item |
| `eventName` | e.g. `"screen_view"` | e.g. `"screen_view"` | Maps to our event type names |
| `timestamp` | ISO 8601 string | ISO 8601 string | `new Date().toISOString()` |
| `attributes` | flat key-value object | flat key-value object | All context + event data merged flat |
| `app.name` | in `attributes` | in `attributes` | Same key |
| `app.version` | in `attributes` | in `attributes` | Same key |
| `device.id` | in `attributes` | in `attributes` | See device ID format below |
| `device.platform` | `"android"` | `"ios"` / `"android"` / `"web"` | From Capacitor |
| `session.id` | in `attributes` | in `attributes` | See session ID format below |
| `user.id` | in `attributes` | in `attributes` | Same key |
| Auth header | `X-API-Key` | `X-API-Key` | **Changed from our original design** |

### ID formats (match Android SDK patterns)

```
device.id:  "device_{timestampMs}_{8hexchars}_{platform}"
            e.g. "device_1704067200000_a8b9c2d1_web"

session.id: "session_{timestampMs}_{8hexchars}_{platform}"
            e.g. "session_1704067200000_x9y8z7w6_web"

user.id:    "user_{timestampMs}_{8hexchars}"
            e.g. "user_1704067200000_abcd1234"
            (only present after EdgeRum.identify() — or auto-generated anonymous ID)
```

> **Device ID note**: The Android SDK generates its own device ID format. We must match it
> structurally. `device.id` is SHA-256 derived from Capacitor's `Device.getId()` but formatted
> to the `device_{ts}_{hex}_{platform}` pattern. On web (non-native), generate deterministically
> from `navigator.userAgent` + a stored random suffix in `localStorage`.

---

## eventName mapping — web SDK to Android SDK equivalents

The `eventName` field must use names consistent with what the Android SDK already sends so
the backend can process both platforms in the same pipeline.

| Web SDK concept | `eventName` value | Android SDK equivalent |
|---|---|---|
| Angular route change | `screen_view` | `screen_view` (Activity/Fragment) |
| HTTP request | `network_request` | (from TelemetryInterceptor) |
| Web Vital (LCP, INP etc.) | `performance` | `performance` (frame_drop, memory) |
| JS / unhandled error | `app.crash` | `app.crash` (crash events) |
| Custom `EdgeRum.track()` | `custom_event` | `custom_event` |
| Custom `EdgeRum.time()` | `custom_metric` | `custom_metric` |
| App foreground/background | `app_lifecycle` | `app_lifecycle` |
| Page load timing | `page_load` | *(web-only — new, backend must add)* |
| Ionic page enter/leave | `screen_timing` | *(web-only — new, backend must add)* |
| Network connectivity change | `network_change` | *(web-only — new, backend must add)* |

> **New event types requiring backend work** — see the Backend Changes section at the bottom
> of this file. These three new `eventName` values do not exist in the Android SDK and the
> Kafka processor will need to be updated to handle them.

---

## Complete payload example — what edge-rum sends

```jsonc
// POST /collector/telemetry    (same endpoint as Android SDK)
// Content-Type: application/json
// X-API-Key: edge_your_api_key_here

{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "type": "batch",
  "device_id": "device_1704067200000_a8b9c2d1_web",
  "events": [

    // ── screen_view (Angular route change) ──────────────────────────────
      {
        "type": "event",
        "eventName": "screen_view",
        "timestamp": "2024-01-15T10:30:00.123Z",
        "attributes": {
          "app.name": "MyApp",
          "app.version": "2.1.0",
          "app.package": "com.yourco.app",
          "app.environment": "production",
          "device.id": "device_1704067200000_a8b9c2d1_web",
          "device.platform": "ios",
          "device.model": "iPhone 15 Pro",
          "device.manufacturer": "Apple",
          "device.os": "ios",
          "device.osVersion": "17.4",
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
          "session.startTime": "2024-01-15T10:25:00.000Z",
          "session.sequence": 1,
          "user.id": "user_1704067200000_abcd1234",
          "sdk.version": "1.0.0",
          "sdk.platform": "ionic-angular-capacitor",
          "navigation.from_screen": "HomeScreen",
          "navigation.to_screen": "ProductDetailScreen",
          "navigation.method": "push",
          "navigation.route_type": "main_flow",
          "navigation.has_arguments": true,
          "navigation.timestamp": "2024-01-15T10:30:00.123Z",
          "navigation.duration_ms": 187
        }
      },

      // ── network_request (HTTP capture) ──────────────────────────────────
      {
        "type": "event",
        "eventName": "network_request",
        "timestamp": "2024-01-15T10:30:00.456Z",
        "attributes": {
          "app.name": "MyApp",
          "app.version": "2.1.0",
          "app.package": "com.yourco.app",
          "app.environment": "production",
          "device.id": "device_1704067200000_a8b9c2d1_web",
          "device.platform": "ios",
          "session.id": "session_1704067200000_x9y8z7w6_web",
          "session.sequence": 1,
          "user.id": "user_1704067200000_abcd1234",
          "sdk.version": "1.0.0",
          "sdk.platform": "ionic-angular-capacitor",
          "network.url": "https://api.example.com/products",
          "network.method": "GET",
          "network.status_code": 200,
          "network.duration_ms": 342,
          "network.request_body_size": 0,
          "network.response_body_size": 4210,
          "network.parent_screen": "ProductDetailScreen"
        }
      },

      // ── performance (Web Vital) ──────────────────────────────────────────
      {
        "type": "event",
        "eventName": "performance",
        "timestamp": "2024-01-15T10:30:01.000Z",
        "attributes": {
          "app.name": "MyApp",
          "app.version": "2.1.0",
          "app.package": "com.yourco.app",
          "app.environment": "production",
          "device.id": "device_1704067200000_a8b9c2d1_web",
          "device.platform": "ios",
          "session.id": "session_1704067200000_x9y8z7w6_web",
          "session.sequence": 1,
          "user.id": "user_1704067200000_abcd1234",
          "sdk.version": "1.0.0",
          "sdk.platform": "ionic-angular-capacitor",
          "performance.metric_name": "LCP",
          "performance.value": 1240,
          "performance.unit": "ms",
          "performance.rating": "good",
          "performance.screen": "ProductDetailScreen"
        }
      },

      // ── app.crash (JS error) ─────────────────────────────────────────────
      {
        "type": "event",
        "eventName": "app.crash",
        "timestamp": "2024-01-15T10:30:02.000Z",
        "attributes": {
          "app.name": "MyApp",
          "app.version": "2.1.0",
          "app.package": "com.yourco.app",
          "app.environment": "production",
          "device.id": "device_1704067200000_a8b9c2d1_web",
          "device.platform": "ios",
          "session.id": "session_1704067200000_x9y8z7w6_web",
          "session.sequence": 1,
          "user.id": "user_1704067200000_abcd1234",
          "sdk.version": "1.0.0",
          "sdk.platform": "ionic-angular-capacitor",
          "exception_type": "TypeError",
          "message": "Cannot read properties of undefined (reading 'name')",
          "stacktrace": "TypeError: Cannot read...\n  at ProductDetailComponent...",
          "is_fatal": false,
          "handled": false,
          "error_context": "screen:ProductDetailScreen",
          "cause": "UnhandledError",
          "runtime": "webview"
        }
      },

      // ── custom_event (EdgeRum.track()) ───────────────────────────────────
      {
        "type": "event",
        "eventName": "custom_event",
        "timestamp": "2024-01-15T10:30:03.000Z",
        "attributes": {
          "app.name": "MyApp",
          "app.version": "2.1.0",
          "app.package": "com.yourco.app",
          "app.environment": "production",
          "device.id": "device_1704067200000_a8b9c2d1_web",
          "device.platform": "ios",
          "session.id": "session_1704067200000_x9y8z7w6_web",
          "session.sequence": 1,
          "user.id": "user_1704067200000_abcd1234",
          "sdk.version": "1.0.0",
          "sdk.platform": "ionic-angular-capacitor",
          "event.name": "checkout_started",
          "event.value": 49.99,
          "event.currency": "GBP"
        }
      },

      // ── custom_metric (EdgeRum.time()) ───────────────────────────────────
      {
        "type": "event",
        "eventName": "custom_metric",
        "timestamp": "2024-01-15T10:30:04.000Z",
        "attributes": {
          "app.name": "MyApp",
          "app.version": "2.1.0",
          "app.package": "com.yourco.app",
          "app.environment": "production",
          "device.id": "device_1704067200000_a8b9c2d1_web",
          "device.platform": "ios",
          "session.id": "session_1704067200000_x9y8z7w6_web",
          "session.sequence": 1,
          "user.id": "user_1704067200000_abcd1234",
          "sdk.version": "1.0.0",
          "sdk.platform": "ionic-angular-capacitor",
          "metric.name": "image_upload",
          "metric.value": 890,
          "metric.unit": "ms",
          "metric.file_size_kb": 2048
        }
      },

      // ── app_lifecycle ────────────────────────────────────────────────────
      {
        "type": "event",
        "eventName": "app_lifecycle",
        "timestamp": "2024-01-15T10:30:05.000Z",
        "attributes": {
          "app.name": "MyApp",
          "app.version": "2.1.0",
          "app.package": "com.yourco.app",
          "app.environment": "production",
          "device.id": "device_1704067200000_a8b9c2d1_web",
          "device.platform": "ios",
          "session.id": "session_1704067200000_x9y8z7w6_web",
          "session.sequence": 1,
          "user.id": "user_1704067200000_abcd1234",
          "sdk.version": "1.0.0",
          "sdk.platform": "ionic-angular-capacitor",
          "lifecycle.event": "foreground",
          "lifecycle.cold_start_ms": 1240
        }
      },

      // ── page_load (NEW — web only) ───────────────────────────────────────
      {
        "type": "event",
        "eventName": "page_load",
        "timestamp": "2024-01-15T10:30:06.000Z",
        "attributes": {
          "app.name": "MyApp",
          "app.version": "2.1.0",
          "app.package": "com.yourco.app",
          "app.environment": "production",
          "device.id": "device_1704067200000_a8b9c2d1_web",
          "device.platform": "ios",
          "session.id": "session_1704067200000_x9y8z7w6_web",
          "session.sequence": 1,
          "sdk.version": "1.0.0",
          "sdk.platform": "ionic-angular-capacitor",
          "page.ttfb_ms": 180,
          "page.dom_content_loaded_ms": 420,
          "page.load_duration_ms": 980,
          "page.resource_count": 24,
          "page.route": "/home"
        }
      },

      // ── screen_timing (NEW — web only) ──────────────────────────────────
      {
        "type": "event",
        "eventName": "screen_timing",
        "timestamp": "2024-01-15T10:30:07.000Z",
        "attributes": {
          "app.name": "MyApp",
          "app.version": "2.1.0",
          "app.package": "com.yourco.app",
          "app.environment": "production",
          "device.id": "device_1704067200000_a8b9c2d1_web",
          "device.platform": "ios",
          "session.id": "session_1704067200000_x9y8z7w6_web",
          "session.sequence": 1,
          "sdk.version": "1.0.0",
          "sdk.platform": "ionic-angular-capacitor",
          "screen.name": "ProductDetailScreen",
          "screen.event": "enter",
          "screen.duration_ms": 95
        }
      },

      // ── network_change (NEW — web only) ─────────────────────────────────
      {
        "type": "event",
        "eventName": "network_change",
        "timestamp": "2024-01-15T10:30:08.000Z",
        "attributes": {
          "app.name": "MyApp",
          "app.version": "2.1.0",
          "app.package": "com.yourco.app",
          "app.environment": "production",
          "device.id": "device_1704067200000_a8b9c2d1_web",
          "device.platform": "ios",
          "session.id": "session_1704067200000_x9y8z7w6_web",
          "session.sequence": 1,
          "sdk.version": "1.0.0",
          "sdk.platform": "ionic-angular-capacitor",
          "network.connected": true,
          "network.type": "wifi",
          "network.previous_type": "cellular"
        }
      }

  ]
}
```

---

## PayloadBuilder implementation notes

Because every event carries the full context (app, device, session, user) as flat attributes,
`PayloadBuilder` must:

1. Maintain a `contextAttributes` object in `SessionManager` — updated once on init and
   on any change (user identify, network change, etc.).
2. On each event, call `{ ...contextAttributes, ...eventAttributes }` to merge flat.
3. Build the outer envelope: `{ timestamp: new Date().toISOString(), type: "batch", device_id: events[0].attributes["device.id"], events: [...] }`.
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
│   ├── payload-schema.json
│   ├── decisions.md
│   ├── terminology.md
│   └── backend-changes.md          ← NEW: what backend team must implement
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
  endpoint?: string;                 // default: https://edgetelemetry.ncgafrica.com/collector/telemetry
  appName?: string;                  // used as app.name in all events
  appVersion?: string;               // used as app.version
  appPackage?: string;               // used as app.package (e.g. "com.yourco.app")
  environment?: 'production' | 'staging' | 'development';
  sampleRate?: number;               // 0.0–1.0, default 1.0
  ignoreUrls?: (string | RegExp)[];
  maxQueueSize?: number;             // default 200
  flushIntervalMs?: number;          // default 5000
  batchSize?: number;                // max events per payload, default 30 (matches Android)
  sanitizeUrl?: (url: string) => string;
  debug?: boolean;
}
```

### `EdgeRum` static methods
```typescript
EdgeRum.init(config: EdgeRumConfig): void
EdgeRum.identify(user: UserContext): void
EdgeRum.track(name: string, attributes?: Record<string, string | number | boolean>): void
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
expect(payload.type).toBe('batch');
expect(payload.device_id).toMatch(/^device_/);
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
device.id:   "device_{Date.now()}_{8hexchars}_{platform}"
session.id:  "session_{Date.now()}_{8hexchars}_{platform}"
user.id:     "user_{Date.now()}_{8hexchars}"
```

Generate the 8 hex chars using `crypto.getRandomValues` or `Math.random().toString(16)`.
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
2. Touches the wire? → Apply Rule 2 (JSON only, Android envelope).
3. Adding a new `eventName`? → Check `docs/backend-changes.md` — does the backend know?
4. Attributes nested? → Flatten them. Always primitives only.
5. Timestamp field? → ISO 8601 string, never Unix ms.
6. Auth header? → `X-API-Key`, never `Authorization: Bearer`.
7. Involves Capacitor? → Guard with `isNativePlatform()`.
8. Angular-specific? → Goes in `packages/angular/`, not `packages/core/`.
9. New event field? → Update `docs/payload-schema.json` first.
10. Non-obvious choice? → Write an entry in `docs/decisions.md`.

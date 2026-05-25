# Backend integration

How edge-rum talks to your backend. Use this page when integrating against a self-hosted backend, verifying the contract in tests, or reviewing data at ingestion.

**Wire contract version:** `3.1.0` (every event carries this as `sdk.contract_version`).

For the conceptual overview of *what* the SDK emits, read [TECHNICAL_GUIDE.md](./TECHNICAL_GUIDE.md). This document is the wire-level reference.

---

## Endpoint

```
POST <your-endpoint>
```

There is no default host or path — the consumer provides the full endpoint URL via `EdgeRumConfig.endpoint`. The `EdgeTelemetryProcessor` backend convention is `https://your-collector/collector/telemetry` but the SDK doesn't enforce any path.

## Headers

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-API-Key` | `edge_...` — the configured `apiKey` |

Authentication is header-based. There is no bearer token, no OAuth, and no cookie.

The collector tier is expected to validate `X-API-Key`, resolve it to `tenant_id`, and forward to downstream processing. The SDK does **not** send `tenant_id` — the collector adds it server-side.

---

## Request body — envelope

Every body is JSON. Outer envelope:

```jsonc
{
  "type": "telemetry_batch",
  "timestamp": "2026-05-25T09:00:42.000Z",
  "location": "Nairobi/Kenya",         // optional, from EdgeRumConfig.location
  "batch_size": 3,
  "events": [ ...event and metric items ]
}
```

| Field | Rule |
|---|---|
| `type` | Always the literal string `"telemetry_batch"`. |
| `timestamp` | ISO 8601 string of when the SDK built this batch. Never Unix ms. |
| `location` | Optional per-install location tag. Omitted (not empty) when unset. |
| `batch_size` | Integer; equals `events.length`. |
| `events` | Array of items. Each is either an event (`type: 'event'` + `eventName`) or a metric (`type: 'metric'` + `metricName` + `value`). |

The SDK never sends `tenant_id`, never sends top-level `device_id`. The collector enriches `tenant_id` server-side. `device.id` lives inside each item's `attributes`.

---

## Item shapes

### Event

```jsonc
{
  "type": "event",
  "eventName": "navigation",
  "timestamp": "2026-05-25T09:00:42.123Z",
  "attributes": { /* flat primitives only */ }
}
```

### Metric

```jsonc
{
  "type": "metric",
  "metricName": "FCP",
  "value": 670,
  "timestamp": "2026-05-25T09:00:00.500Z",
  "attributes": { /* flat primitives only */ }
}
```

### Flat-primitive rule

`attributes` values are always `string | number | boolean`. Never a nested object, never an array. Keys use dot notation for grouping. **One documented exception:** `crash.breadcrumbs` on `app.crash` events is a JSON-string the backend parses. Schema documents this explicitly.

---

## Backend dispatch (`EdgeTelemetryProcessor`'s `event_processor.py`)

The processor branches on item shape:

| Condition | Handler |
|---|---|
| `item.type === 'metric'` | Metric pipeline (Web Vitals, long_task, resource_timing, custom timings) |
| `item.eventName === 'navigation'` | `rum_navigation_events` |
| `item.eventName === 'screen.duration'` | `rum_screen_durations` |
| `item.eventName === 'http.request'` | `rum_http_requests` |
| `item.eventName === 'app.crash'` | `rum_crashes` (web + native) |
| `item.eventName === 'user.profile.update'` | `rum_users` upsert |
| `item.eventName === 'session.started'` | `rum_sessions` insert/upsert (open) |
| `item.eventName === 'session.finalized'` | `rum_sessions` close (set duration, journey, end_reason) |
| Anything else | Catch-all (`performance_events` or equivalent) |

### Events that land in catch-all today (need dedicated handlers later)

Backend can ingest these without erroring — they just don't get rich per-event tables yet:

| `eventName` / `metricName` | Source | Status |
|---|---|---|
| `user.interaction` | Click capture | catch-all (consider `rum_interactions`) |
| `app_lifecycle` | Foreground / background | catch-all |
| `page_load` | Web only | catch-all |
| `network_change` | Capacitor Network plugin | catch-all |
| `custom_event` | `EdgeRum.track()` | catch-all (consumer-defined names) |
| `long_task` (metric) | PerformanceObserver `longtask` | catch-all metric (consider `rum_long_tasks`) |
| `resource_timing` (metric) | PerformanceObserver `resource` | catch-all metric |
| Custom metric names from `EdgeRum.time()` | Consumer | catch-all metric |

---

## Required identity attributes

The collector should drop or quarantine events missing any of these:

- `app.package_name`
- `device.id`
- `device.platform` (`ios` / `android` / `web`)
- `user.id`
- `session.id`
- `session.start_time`

Everything else is optional but the [full identity reference is in TECHNICAL_GUIDE.md § 10](./TECHNICAL_GUIDE.md#10-identity-attribute-reference).

---

## ID formats

```
device.id:   "device_{Date.now()}_{16hexchars}_{platform}"
             e.g. "device_1716624000000_a8b9c2d176b4ce41_ios"

session.id:  "session_{Date.now()}_{16hexchars}_{platform}"
             e.g. "session_1716624000000_x9y8z7w6deadbeef_ios"

user.id:     "user_{Date.now()}_{16hexchars}"
             e.g. "user_1716624000000_abcd1234deadbeef"
```

Backend regex pattern:
```regex
^device_\d+_[a-f0-9]{16}_(ios|android|web)$
^session_\d+_[a-f0-9]{16}_(ios|android|web)$
^user_\d+_[a-f0-9]{16}$
```

**Format change in wire-contract 3.1.0:** the random segment widened from 8 to 16 hex chars (64 bits of entropy). Backends that hard-coded the 8-char regex must update.

---

## Complete example — single batch

```jsonc
POST https://your-collector/collector/telemetry
Content-Type: application/json
X-API-Key: edge_abc123

{
  "type": "telemetry_batch",
  "timestamp": "2026-05-25T09:00:42.000Z",
  "location": "Nairobi/Kenya",
  "batch_size": 4,
  "events": [
    {
      "type": "event",
      "eventName": "session.started",
      "timestamp": "2026-05-25T09:00:00.000Z",
      "attributes": {
        "app.name": "MyApp",
        "app.version": "2.1.0",
        "app.package_name": "com.yourco.app",
        "app.build_number": "210",
        "app.environment": "production",
        "device.id": "device_1716624000000_a8b9c2d176b4ce41_ios",
        "device.platform": "ios",
        "device.platform_version": "17.4",
        "device.model": "iPhone 15 Pro",
        "device.manufacturer": "Apple",
        "network.type": "wifi",
        "session.id": "session_1716624000000_x9y8z7w6deadbeef_ios",
        "session.start_time": "2026-05-25T09:00:00.000Z",
        "session.sequence": 0,
        "session.is_first_session": false,
        "session.total_sessions": 5,
        "user.id": "user_1716624000000_abcd1234deadbeef",
        "sdk.version": "3.2.0",
        "sdk.contract_version": "3.1.0",
        "sdk.platform": "ionic-angular-capacitor",
        "session.start_reason": "init"
      }
    },
    {
      "type": "event",
      "eventName": "navigation",
      "timestamp": "2026-05-25T09:00:07.000Z",
      "attributes": {
        "// identity attrs": "...same as above...",
        "navigation.from_screen": "/login",
        "navigation.to_screen": "/tabs/home",
        "navigation.method": "replace",
        "navigation.route_type": "main_flow",
        "navigation.has_arguments": false,
        "navigation.timestamp": "2026-05-25T09:00:07.000Z"
      }
    },
    {
      "type": "metric",
      "metricName": "FCP",
      "value": 670,
      "timestamp": "2026-05-25T09:00:08.500Z",
      "attributes": {
        "// identity attrs": "...",
        "metric.unit": "ms",
        "metric.rating": "good",
        "metric.screen": "/tabs/home"
      }
    },
    {
      "type": "event",
      "eventName": "session.finalized",
      "timestamp": "2026-05-25T09:05:12.000Z",
      "attributes": {
        "// identity attrs": "...",
        "session.id": "session_1716624000000_x9y8z7w6deadbeef_ios",
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
        "sdk.error_count": 0
      }
    }
  ]
}
```

---

## Response contract

| Status | Meaning | SDK behaviour |
|---|---|---|
| `2xx` | Accepted | Drop the batch from buffer; increment `session.sequence`; opportunistically drain offline queue |
| `4xx` (except 429) | Permanent reject | Discard. Warn in debug mode. |
| `429` | Rate limited | Retry; respect `Retry-After` header |
| `503` | Temporarily unavailable | Retry |
| `0` / network error | Unreachable | Retry, then push to offline queue |

Retry schedule: immediate → 2s → 8s → 30s → offline queue. Offline queue stores up to `maxQueueSize` batches (default 200) and drains automatically on reconnect / foreground / next successful send.

---

## CORS

For consumers running the SDK in a browser (not just Capacitor WebView), the browser will preflight every cross-origin request. Your backend must respond to `OPTIONS <endpoint>` with:

```
Access-Control-Allow-Origin: <your app origin>
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-API-Key
Access-Control-Max-Age: 86400
```

For Capacitor native: requests go through native HTTP (`createCapacitorHttpFetch`), bypassing the browser's CORS check. Web fallback still needs CORS.

A misconfigured preflight is the most common integration failure. If no data is arriving from the web build, check the network tab for a failed `OPTIONS` request before anything else.

---

## Per-event attribute reference (high level)

The canonical attribute set per event/metric is in [`payload-schema.json`](./payload-schema.json) (a JSON Schema). Below is a quick map of which `*Attributes` block in the schema applies to which event/metric:

| Item | Schema block |
|---|---|
| `navigation` event | `navigationAttributes` |
| `screen.duration` event | `screenDurationAttributes` |
| `http.request` event | `httpRequestAttributes` |
| `app.crash` event | `crashAttributes` + `crashBreadcrumbAttributes` |
| `user.profile.update` event | `userProfileUpdateAttributes` |
| `user.interaction` event | `userInteractionAttributes` |
| `session.started` event | `sessionStartedAttributes` |
| `session.finalized` event | `sessionFinalizedAttributes` |
| `app_lifecycle` event | `appLifecycleAttributes` |
| `page_load` event | `pageLoadAttributes` |
| `network_change` event | `networkChangeAttributes` |
| Web Vital metric | `metricAttributes` |
| `long_task` metric | `longTaskMetricAttributes` |
| `resource_timing` metric | `resourceTimingMetricAttributes` |

---

## Validating payloads in your own tests

```typescript
const body = JSON.parse(request.body);

// Envelope
expect(body.type).toBe('telemetry_batch');
expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
expect(body.batch_size).toBe(body.events.length);
expect(body).not.toHaveProperty('device_id');     // device.id is per-event, not envelope-level
expect(body).not.toHaveProperty('tenant_id');     // collector resolves this server-side

// Each item
for (const item of body.events) {
  expect(['event', 'metric']).toContain(item.type);
  expect(item.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(item.attributes).toBeDefined();
  if (item.type === 'event') {
    expect(typeof item.eventName).toBe('string');
  } else {
    expect(typeof item.metricName).toBe('string');
    expect(typeof item.value).toBe('number');
  }
  // Flat primitives only (with the documented JSON-string exception on crash.breadcrumbs)
  for (const [key, value] of Object.entries(item.attributes)) {
    expect(['string', 'number', 'boolean']).toContain(typeof value);
  }
  // Required identity attributes
  expect(item.attributes['app.package_name']).toBeDefined();
  expect(item.attributes['device.id']).toMatch(/^device_\d+_[a-f0-9]{16}_(ios|android|web)$/);
  expect(item.attributes['session.id']).toMatch(/^session_\d+_[a-f0-9]{16}_(ios|android|web)$/);
  expect(item.attributes['user.id']).toMatch(/^user_\d+_[a-f0-9]{16}$/);
  expect(item.attributes['sdk.contract_version']).toBe('3.1.0');
}

// Headers
expect(request.headers['content-type']).toBe('application/json');
expect(request.headers['x-api-key']).toMatch(/^edge_/);
```

---

## Version compatibility quick reference

| SDK version | Wire-contract version | What the backend needs |
|---|---|---|
| 3.0.0 | (none — no `sdk.contract_version` field yet) | Envelope `telemetry_batch`, dispatch for `navigation` / `screen.duration` / `http.request` / `app.crash` / `app_lifecycle` / `page_load` / `network_change` / `custom_event`; metric items routed by `metricName`. |
| 3.0.1 | 3.0.0 | Adds `user.profile.update` event; Web Vitals shipped as metric items (not `performance` events). |
| 3.1.0 | 3.1.0 | Adds `user.interaction` event, `long_task` + `resource_timing` metrics, `crash.breadcrumbs` JSON-string on crashes, `sdk.error_count` on `session.finalized`, `session.is_first_session` / `session.total_sessions` / `session.visited_screens` / `session.screen_count` / `session.event_count` / `session.metric_count` / `session.journey_truncated`. ID regex widens 8 → 16 hex chars. `sdk.contract_version` now on every event. |
| 3.2.0 | 3.1.0 | Same wire contract. Adds native crash bridge — new `cause` values (`NativeCrash`, `ANR`, `Hang`), `runtime: 'native'`, and namespaced `crash.id` / `crash.captured_at` / `crash.platform` / `crash.signal` / `crash.thread` / `crash.symbolication` / `anr.duration_ms` attrs on `app.crash`. |

# Backend integration

How edge-rum talks to your backend. Use this page when integrating against a self-hosted
backend, verifying the contract in tests, or reviewing data at ingestion.

## Endpoint

```
POST /collector/telemetry
```

Default host: `https://edgetelemetry.ncgafrica.com`. Override via the `endpoint` option.

## Headers

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-API-Key` | `edge_...` — the configured `apiKey` |
| `X-Edge-Rum-Version` | SDK semver — used for diagnostics |
| `X-Edge-Retry` | Retry attempt number — present only on retries |

Authentication is header-based. There is no bearer token, no OAuth flow, and no cookie.

## Request body

Every request body is JSON. The shape is an envelope containing one or more events:

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "type": "batch",
  "events": [
    {
      "type": "event",
      "eventName": "screen_view",
      "timestamp": "2024-01-15T10:30:00.123Z",
      "attributes": {
        "app.name": "MyApp",
        "app.version": "2.1.0",
        "device.platform": "ios",
        "session.id": "session_1704067200000_x9y8z7w6_ios",
        "sdk.platform": "ionic-angular-capacitor"
      }
    }
  ]
}
```

### Envelope rules

- `timestamp` — ISO 8601 string marking when the send was built. Never Unix milliseconds.
- `type` — always the literal string `"batch"`.
- `events` — array of event objects. Never empty for a send.

### Event rules

- `type` — always `"event"`.
- `eventName` — one of the values listed below.
- `timestamp` — ISO 8601 string marking when the event happened.
- `attributes` — flat key-value object. **Every value is a `string`, `number`, or
  `boolean`.** Never a nested object, never an array. Keys use dot notation for
  grouping (e.g. `device.os`, `network.type`).

The canonical schema is at `docs/payload-schema.json`.

## Event names

| `eventName` | Source |
|---|---|
| `screen_view` | Angular route change |
| `network_request` | Captured HTTP request |
| `performance` | Web performance measurement |
| `app.crash` | Unhandled error or rejection |
| `custom_event` | `EdgeRum.track()` |
| `custom_metric` | `EdgeRum.time()` |
| `app_lifecycle` | Foreground / background |
| `page_load` | WebView page load timing |
| `screen_timing` | Ionic page enter / leave |
| `network_change` | Connectivity change |

## Response contract

| Status | Meaning | SDK behaviour |
|---|---|---|
| `2xx` | Accepted | Drop the send, increment session sequence |
| `4xx` (not 429) | Permanent reject | Discard. Warn in debug mode |
| `429` | Rate limited | Retry, respect `Retry-After` |
| `503` | Temporarily unavailable | Retry |
| `0` / network error | Unreachable | Retry, then queue for later |

Retry schedule: immediate, 2s, 8s, 30s. If still failing, the send is stored locally and
retried when the device comes back online or the app returns to the foreground.

## CORS

The browser will preflight every cross-origin request. Your backend must respond to
`OPTIONS /collector/telemetry` with:

```
Access-Control-Allow-Origin: <your app origin>
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-API-Key, X-Edge-Rum-Version, X-Edge-Retry
Access-Control-Max-Age: 86400
```

A misconfigured preflight is the single most common integration failure — if no data is
arriving, check the network tab for a failed `OPTIONS` request before anything else.

## Verifying the contract locally

A mock ingest server ships with the repo at `demo/docker-compose.yml`. It accepts any
request, validates the `X-API-Key` header format, pretty-prints the payload to stdout,
and responds `200 OK`. Point `endpoint` at it while developing.

```bash
docker compose -f demo/docker-compose.yml up
```

## Validating payloads in your own tests

```typescript
const body = JSON.parse(request.body);

expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
expect(body.type).toBe('batch');
expect(body.events).toBeInstanceOf(Array);

for (const event of body.events) {
  expect(event.type).toBe('event');
  expect(event.eventName).toBeDefined();
  for (const value of Object.values(event.attributes)) {
    expect(['string', 'number', 'boolean']).toContain(typeof value);
  }
}

expect(request.headers['content-type']).toBe('application/json');
expect(request.headers['x-api-key']).toMatch(/^edge_/);
```

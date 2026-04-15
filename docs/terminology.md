# Terminology Guide

Defines the vocabulary for the edge-rum SDK. Applies to all public-facing surfaces:
TypeScript types, method names, docs, READMEs, error messages, and changelogs.

Does NOT apply to: `internal/`, `instrumentation/`, `transport/` directories, or internal
variable names and comments that are never surfaced externally.

---

## Banned terms — never use in public surface

| Banned term | Use instead |
|---|---|
| `span` / `trace` / `tracing` | `event` |
| `tracer` / `TracerProvider` | (hide entirely) |
| `SpanProcessor` / `SpanExporter` | (hide entirely) |
| `MeterProvider` / `LoggerProvider` | (hide entirely) |
| `instrumentation` | `capture` |
| `instrument` (verb) | `capture`, `record`, `monitor` |
| `telemetry` | `performance data`, `events` |
| `metric` / `metrics` (in API names) | `performance data` |
| `OTLP` | (never mentioned) |
| `OpenTelemetry` | (never mentioned) |
| `emit` (in data context) | `record`, `capture`, `send` |
| `context propagation` | (internal — never mentioned) |
| `sampling` | `capture rate` |
| `collector` | `your backend` |
| `pipeline` | (internal — never mentioned) |
| `batch` / `batching` | `sends` (user-facing only) |
| `flush` | `sends` (user-facing docs only) |
| `resource attributes` | `device info`, `app info` |

---

## Approved consumer vocabulary

### Describing what the SDK does

| Concept | Approved term | Example |
|---|---|---|
| Recording data | **captures** / **records** | "edge-rum automatically captures HTTP requests" |
| A single data point | **event** | "Each user action becomes an event" |
| A collection of events | **events** | "Events are sent to your backend" |
| A user's session | **session** | "A session starts when the app opens" |
| Performance measurements | **performance data** | "Web performance data is captured automatically" |
| Sending data | **sends** | "The SDK sends data every 5 seconds" |
| The data store | **your backend** | "Events are sent to your backend" |
| How often data is sent | **send interval** | "Configure the send interval with flushIntervalMs" |

### Public API method naming

| Action | Method name |
|---|---|
| Start the SDK | `EdgeRum.init(config)` |
| Set user identity | `EdgeRum.identify({ id: 'u_123' })` |
| Record a custom event | `EdgeRum.track('checkout_started')` |
| Time an operation | `const t = EdgeRum.time('upload'); t.end()` |
| Record a handled error | `EdgeRum.captureError(err)` |
| Stop recording | `EdgeRum.disable()` |
| Resume recording | `EdgeRum.enable()` |
| Get session reference | `EdgeRum.getSessionId()` |

### Config option naming

| Concept | Config key | Type |
|---|---|---|
| Authentication | `apiKey` | `string` — must start with `"edge_"` |
| Backend URL | `endpoint` | `string` |
| App display name | `appName` | `string` |
| App version | `appVersion` | `string` |
| App package / bundle | `appPackage` | `string` |
| Deployment context | `environment` | `'production' \| 'staging' \| 'development'` |
| Capture rate | `sampleRate` | `number` (0.0–1.0) |
| URLs to ignore | `ignoreUrls` | `(string \| RegExp)[]` |
| Max offline storage | `maxQueueSize` | `number` |
| Send interval | `flushIntervalMs` | `number` |
| Events per send | `batchSize` | `number` |
| URL cleaner | `sanitizeUrl` | `(url: string) => string` |
| Debug logging | `debug` | `boolean` |

---

## Internal eventName values

These appear in the JSON payload `eventName` field and in backend storage. They are NOT
part of the consumer-facing API but must be consistent with the Android SDK.

| eventName | What it represents | Android SDK equivalent |
|---|---|---|
| `screen_view` | Angular route change | Activity / Fragment navigation |
| `network_request` | HTTP request captured automatically | TelemetryInterceptor |
| `performance` | Web Vital measurement | frame_drop, performance |
| `app.crash` | JS error, unhandled rejection, native crash | app.crash |
| `custom_event` | EdgeRum.track() | custom_event |
| `custom_metric` | EdgeRum.time() | custom_metric |
| `app_lifecycle` | App foreground / background | app_lifecycle |
| `page_load` | WebView page load timing | Web-only (new) |
| `screen_timing` | Ionic page enter/leave duration | Web-only (new) |
| `network_change` | Connectivity state change | Web-only (new) |

---

## Documentation language rules

### Write this...

```
"edge-rum automatically captures all HTTP requests made by your app."
"Use EdgeRum.track() to record important user actions."
"Events are sent to your backend every 5 seconds."
"If the device goes offline, events are stored locally and sent when connectivity returns."
"Configure the send interval with the flushIntervalMs option."
```

### Not this...

```
"edge-rum instruments all fetch and XHR calls via auto-instrumentation."
"Use EdgeRum.track() to emit a custom span."
"Telemetry is exported via OTLP/HTTP every 5 seconds."
"Spans are buffered in the offline queue when connectivity is lost."
"Configure BatchSpanProcessor delay with the flushIntervalMs option."
```

---

## JSDoc rules

### Public methods — consumer-facing JSDoc

```typescript
/**
 * Records a custom event with optional attributes.
 *
 * @param name - Event name. Use dot notation for namespacing: 'checkout.started'
 * @param attributes - Optional key-value data attached to the event.
 *
 * @example
 * EdgeRum.track('checkout_started', { value: 49.99, currency: 'GBP' });
 */
track(name: string, attributes?: Record<string, string | number | boolean>): void;
```

### Internal methods — no restrictions on terminology

```typescript
/**
 * Registers OTel FetchInstrumentation and XHR instrumentation.
 * Maps completed spans to network_request eventName via recordEvent().
 * @internal
 */
function registerHttpCapture(config: EdgeRumConfig): void {}
```

---

## Error message format

```typescript
throw new Error('edge-rum: <plain English description>');
```

Examples:
- `throw new Error('edge-rum: apiKey is required')`
- `throw new Error('edge-rum: apiKey must start with "edge_"')`
- `throw new Error('edge-rum: init() must be called before identify()')`
- `throw new Error('edge-rum: endpoint must be a valid URL')`
- `throw new Error('edge-rum: sampleRate must be between 0 and 1')`

Never include OTel class names, package names, or internal file paths in error messages.

---

## Changelog language rules

```markdown
## 1.1.0 — 2026-05-01

### Added
- EdgeRum.time() for recording how long custom operations take
- Ionic page entry and exit timing captured automatically

### Fixed
- HTTP events now correctly attach to the navigation that triggered them
- iOS: events are now reliably sent when the app moves to the background

### Changed
- Default send interval changed from 10s to 5s for faster data visibility
```

Not:
```markdown
## 1.1.0

### Added
- Custom span support via EdgeRum.time() using BatchSpanProcessor
- Ionic ionViewWillEnter/ionViewDidEnter span instrumentation

### Fixed
- Span parent context now correctly propagated during NavigationStart
- iOS: forceFlush() now called on appStateChange isActive:false
```

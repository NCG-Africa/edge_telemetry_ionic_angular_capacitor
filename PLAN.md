# edge-rum SDK — Build Plan

> Real User Monitoring SDK for Ionic Angular Capacitor apps.
> Distributed as `@edgemetrics/rum`. Ships events to the same backend as the Android SDK,
> using the identical batch envelope so the existing Kafka processor handles both platforms
> without modification.

---

## Non-negotiable constraints

These apply to every line of code, every file name, every doc string, and every commit.

**1. No internal terminology in public surface.**
Consumers see `EdgeRum.*` only. The words span, trace, tracer, OpenTelemetry, OTLP,
instrumentation, telemetry, MeterProvider, SpanProcessor — none appear in public types,
error messages, READMEs, or changelogs. Full list in `docs/terminology.md`.

**2. JSON only — always.**
`Content-Type: application/json`. `JSON.stringify(payload)`. No Protobuf, no compression,
no binary encoding. Schema in `docs/payload-schema.json`.

**3. Android SDK envelope compatibility — mandatory.**
The wire format matches the Android SDK exactly. Same Kafka processor, same storage tables,
same dashboards, zero backend branching. Full spec in `CLAUDE.md`.

---

## Supporting documents

Read these before implementing any phase:

| File | Purpose |
|---|---|
| `CLAUDE.md` | Primary AI guide — rules, full payload examples, all conventions |
| `docs/payload-schema.json` | JSON Schema for every eventName and every attribute |
| `docs/backend-changes.md` | What backend team must deliver before/during SDK development |
| `docs/decisions.md` | Architecture decision log ADR-001 through ADR-015 |
| `docs/terminology.md` | Banned/approved vocabulary for all public surfaces |

---

## Dependency versions (pinned)

### Bundled internally — never exposed as peer deps

| Package | Version | Role |
|---|---|---|
| `@opentelemetry/sdk-trace-web` | `^1.25.x` | Internal collection pipeline |
| `@opentelemetry/sdk-metrics` | `^1.25.x` | Internal metrics pipeline |
| `@opentelemetry/auto-instrumentations-web` | `^0.40.x` | XHR, fetch, document-load hooks |
| `@opentelemetry/context-zone` | `^1.25.x` | Zone.js compat — mandatory for Angular |
| `@opentelemetry/resources` | `^1.25.x` | Device/app context carrier |
| `@opentelemetry/semantic-conventions` | `^1.25.x` | Attribute key constants (internal only) |
| `web-vitals` | `^4.x` | LCP, INP, CLS, FCP, TTFB |

### Peer dependencies — consumer installs, not bundled

| Package | Version | Required by |
|---|---|---|
| `@capacitor/core` | `^6.x` | `@edgemetrics/rum-capacitor` |
| `@capacitor/device` | `^6.x` | `@edgemetrics/rum-capacitor` |
| `@capacitor/network` | `^6.x` | `@edgemetrics/rum-capacitor` |
| `@capacitor/app` | `^6.x` | `@edgemetrics/rum-capacitor` |
| `@angular/core` | `>=17.0.0` | `@edgemetrics/rum-angular` |

---

## Wire format — reference

Every payload the SDK sends. Matches the Android SDK batch envelope exactly.

```
POST /collector/telemetry
Content-Type: application/json
X-API-Key: edge_your_key_here
```

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "data": {
    "type": "batch",
    "events": [
      {
        "type": "event",
        "eventName": "screen_view",
        "timestamp": "2024-01-15T10:30:00.123Z",
        "attributes": {
          "app.name": "MyApp",
          "app.version": "2.1.0",
          "app.package": "com.yourco.app",
          "app.environment": "production",
          "device.id": "device_1704067200000_a8b9c2d1_ios",
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
          "session.id": "session_1704067200000_x9y8z7w6_ios",
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
      }
    ]
  }
}
```

**Rules baked into the format:**
- All timestamps: ISO 8601 strings — `new Date().toISOString()` — never Unix ms
- All attributes: flat primitives only — `string | number | boolean` — never nested objects
- Auth: `X-API-Key` header — not `Authorization: Bearer`
- `eventName` values match Android SDK names exactly (see mapping table in `CLAUDE.md`)

### eventName mapping

| Web SDK concept | eventName | Android SDK equivalent |
|---|---|---|
| Angular route change | `screen_view` | Activity / Fragment navigation |
| HTTP request | `network_request` | TelemetryInterceptor |
| Web Vital (LCP, INP, CLS…) | `performance` | frame_drop, performance |
| JS error / unhandled rejection | `app.crash` | app.crash |
| `EdgeRum.track()` | `custom_event` | custom_event |
| `EdgeRum.time()` | `custom_metric` | custom_metric |
| App foreground / background | `app_lifecycle` | app_lifecycle |
| WebView page load | `page_load` | Web-only — new |
| Ionic page enter / leave | `screen_timing` | Web-only — new |
| Network connectivity change | `network_change` | Web-only — new |

---

## Repository structure

```
edge-rum/
├── packages/
│   ├── core/                            # @edgemetrics/rum
│   │   ├── src/
│   │   │   ├── index.ts                 ← PUBLIC BOUNDARY — EdgeRum + types only
│   │   │   ├── EdgeRum.ts               ← Public singleton
│   │   │   ├── types.ts                 ← EdgeRumConfig, UserContext, RumTimer
│   │   │   ├── session/
│   │   │   │   ├── SessionManager.ts    ← Context state, sequence counter, session expiry
│   │   │   │   └── SessionIdGenerator.ts
│   │   │   ├── internal/                ← OTel wiring — NEVER re-exported
│   │   │   │   ├── pipeline.ts          ← WebTracerProvider + ZoneContextManager + BSP
│   │   │   │   ├── collector.ts         ← recordEvent() — single internal entry point
│   │   │   │   └── context.ts
│   │   │   ├── instrumentation/         ← Capture hooks — NEVER re-exported
│   │   │   │   ├── requests.ts          ← fetch + XHR → network_request
│   │   │   │   ├── errors.ts            ← window.error + rejection → app.crash
│   │   │   │   ├── vitals.ts            ← web-vitals → performance
│   │   │   │   └── pageload.ts          ← document-load → page_load
│   │   │   ├── transport/
│   │   │   │   ├── JsonExporter.ts      ← Intercepts spans before OTel serialises
│   │   │   │   ├── PayloadBuilder.ts    ← Builds Android-compatible batch envelope
│   │   │   │   └── RetryTransport.ts    ← fetch + exponential backoff + X-API-Key
│   │   │   └── queue/
│   │   │       └── OfflineQueue.ts      ← @capacitor/preferences or localStorage
│   │   ├── tsup.config.ts
│   │   └── package.json
│   ├── angular/                         # @edgemetrics/rum-angular
│   │   ├── src/
│   │   │   ├── index.ts                 ← PUBLIC BOUNDARY
│   │   │   ├── EdgeRumModule.ts         ← NgModule + forRoot() + APP_INITIALIZER
│   │   │   ├── EdgeRumService.ts        ← Injectable DI wrapper
│   │   │   ├── RouterCapture.ts         ← Router.events → screen_view
│   │   │   ├── ErrorCapture.ts          ← Angular ErrorHandler → app.crash
│   │   │   └── IonicLifecycleCapture.ts ← Ionic DOM events → screen_timing
│   │   ├── tsup.config.ts
│   │   └── package.json
│   └── capacitor/                       # @edgemetrics/rum-capacitor
│       ├── src/
│       │   ├── index.ts                 ← PUBLIC BOUNDARY
│       │   ├── DeviceContext.ts         ← Device.getInfo() → device.* attributes
│       │   ├── NetworkCapture.ts        ← Network.addListener → network_change
│       │   └── LifecycleCapture.ts      ← App.addListener → app_lifecycle
│       ├── tsup.config.ts
│       └── package.json
├── demo/
│   └── docker-compose.yml               ← Local mock ingest server
├── docs/
│   ├── payload-schema.json
│   ├── decisions.md
│   ├── backend-changes.md
│   └── terminology.md
├── .github/workflows/ci.yml
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── CLAUDE.md
├── PLAN.md
├── CHANGELOG.md
└── THIRD_PARTY_LICENSES
```

---

## Phases overview

| Phase | Name | Outcome | Est. effort |
|---|---|---|---|
| 1 | Foundation | JSON batch events arriving at backend | 2–3 weeks |
| 2 | Signals | Web Vitals, errors, page load | 2–3 weeks |
| 3 | Native | Capacitor device context + lifecycle | 1–2 weeks |
| 4 | Angular | Router, ErrorHandler, Ionic lifecycle | 1–2 weeks |
| 5 | Resilience | Offline queue, retry, flush triggers | 1–2 weeks |
| 6 | Distribution | npm publish, docs, demo | 1 week |

Phases 3 and 4 can run in parallel once Phase 2 is complete.
Total estimate: 8–13 weeks.

---

## Backend dependency — must happen before Phase 1 testing against production

The backend team must complete three items from `docs/backend-changes.md` before the SDK
can send data to the real backend. Until then, use `demo/docker-compose.yml`.

- [ ] **CORS headers** on `/collector/telemetry` — `Access-Control-Allow-Origin: *`,
  `Access-Control-Allow-Headers: Content-Type, X-API-Key`, OPTIONS preflight → 200 OK
- [ ] **`device.platform: "web"`** handled without error in Kafka processor
- [ ] **Unknown attributes** (`sdk.version`, `sdk.platform`, `session.sequence`) do not
  cause payload rejection

---

## Phase 1 — Foundation: JSON batch events to backend

**Goal:** Developer installs `@edgemetrics/rum`, calls `EdgeRum.init()`, and `network_request`
events appear at the backend in the correct Android-compatible batch envelope.

---

### Task 1.1 — Monorepo and tooling

#### Steps

1. Initialise pnpm workspace. `pnpm-workspace.yaml`:
   ```yaml
   packages:
     - 'packages/*'
   ```

2. Bootstrap three packages: `packages/core`, `packages/angular`, `packages/capacitor`.
   Each `package.json` gets `"sideEffects": false` and `"publishConfig": { "access": "public" }`.

3. Root `tsconfig.base.json`:
   ```json
   {
     "compilerOptions": {
       "strict": true,
       "moduleResolution": "bundler",
       "target": "ES2020",
       "lib": ["ES2020", "DOM"],
       "declaration": true,
       "declarationMap": true,
       "sourceMap": true
     }
   }
   ```

4. `tsup.config.ts` in each package:
   ```typescript
   import { defineConfig } from 'tsup';
   export default defineConfig({
     entry: ['src/index.ts'],
     format: ['esm', 'cjs'],
     dts: true,
     treeshake: true,
     clean: true,
     noExternal: [/@opentelemetry\/.*/],  // bundle OTel — never expose it
   });
   ```

5. Add `vitest` for unit tests, `playwright` for integration tests.

6. Add `@changesets/cli` for versioned releases.

7. Add `size-limit` config:
   - `@edgemetrics/rum` core: < 90KB gzipped
   - Full stack (core + angular + capacitor): < 200KB gzipped

8. Create `.github/workflows/ci.yml` with stages:
   `lint → type-check → test → build → terminology-check → attribute-flatness-check → size-check → integration-test → publish (on tag)`

9. Terminology check CI step:
   ```bash
   grep -rE "TracerProvider|SpanProcessor|MeterProvider|opentelemetry|otlp" packages/*/dist/*.d.ts
   # Must exit 1 (no matches) for build to pass
   ```

#### References
- tsup `noExternal`: https://tsup.egoist.dev/#options
- pnpm workspaces: https://pnpm.io/workspaces
- size-limit: https://github.com/ai/size-limit
- Changesets: https://github.com/changesets/changesets

---

### Task 1.2 — Internal collection pipeline

#### Steps

1. Install in `packages/core`:
   ```
   @opentelemetry/sdk-trace-web
   @opentelemetry/resources
   @opentelemetry/semantic-conventions
   @opentelemetry/context-zone
   @opentelemetry/core
   ```

2. Create `src/internal/pipeline.ts`. Exports only `initPipeline(config)` and `flushPipeline()`.
   Neither is re-exported from `index.ts`.

   Inside `initPipeline`:
   - Use `ZoneContextManager` from `@opentelemetry/context-zone` — mandatory for Angular.
     Without this, OTel and Zone.js both patch `Promise`/`setTimeout`, causing context loss
     on Angular async boundaries.
   - Configure `BatchSpanProcessor`:
     - `maxQueueSize: 512`
     - `scheduledDelayMillis: config.flushIntervalMs ?? 5000`
     - `maxExportBatchSize: config.batchSize ?? 30` (matches Android SDK default)
   - Pass `JsonExporter` (Task 1.3) as the exporter
   - Register: `provider.register({ contextManager: new ZoneContextManager() })`

3. Create `src/internal/collector.ts`. Single internal entry point for all instrumentation:
   ```typescript
   // Never exported from index.ts
   function recordEvent(
     eventName: string,
     attributes: Record<string, string | number | boolean>,
     durationMs?: number
   ): void
   ```

4. Write unit test: `initPipeline()` and `recordEvent()` do not throw.

#### Key detail — Zone.js compatibility
Angular patches `Promise` and `setTimeout` via Zone.js. OTel's default
`AsyncLocalStorageContextManager` also patches these — causing double-patching and
context loss inside Angular components. `ZoneContextManager` defers to Zone.js ownership.
This is not configurable — it is always enabled.

#### References
- ZoneContextManager: https://github.com/open-telemetry/opentelemetry-js/tree/main/packages/opentelemetry-context-zone
- BatchSpanProcessor: https://opentelemetry.io/docs/languages/js/exporters/

---

### Task 1.3 — PayloadBuilder and JsonExporter

#### Steps

1. Create `src/transport/PayloadBuilder.ts`.

   Receives collected event data and produces the Android-compatible batch envelope.

   Output shape:
   ```typescript
   {
     timestamp: string;                  // new Date().toISOString()
     data: {
       type: "batch";
       events: Array<{
         type: "event";                  // always "event"
         eventName: string;
         timestamp: string;              // ISO 8601
         attributes: Record<string, string | number | boolean>;  // FLAT only
       }>;
     };
   }
   ```

   Context attributes stamped on every event from `SessionManager.getContextAttributes()`:
   `app.name`, `app.version`, `app.package`, `app.environment`,
   `device.id`, `device.platform`, `device.model`, `device.manufacturer`,
   `device.os`, `device.osVersion`, `device.isVirtual`,
   `device.screenWidth`, `device.screenHeight`, `device.pixelRatio`,
   `device.batteryLevel`, `device.batteryCharging`,
   `network.type`, `network.effectiveType`, `network.downlinkMbps`,
   `session.id`, `session.startTime`, `session.sequence`,
   `user.id` (only if set), `sdk.version`, `sdk.platform`

   Flatness enforcement: runtime assert (debug mode) that no attribute value is an object
   or array. TypeScript constraint `Record<string, string | number | boolean>` catches
   this at compile time.

2. Create `src/transport/JsonExporter.ts`. Implements OTel `SpanExporter` internally.
   On `export(spans, resultCallback)`:
   - `PayloadBuilder.build(spans)` → `RetryTransport.send(payload)`
   - Success: `resultCallback(ExportResultCode.SUCCESS)`
   - Failure: `OfflineQueue.push(JSON.stringify(payload))` then `resultCallback(ExportResultCode.FAILED)`

3. Create `src/transport/RetryTransport.ts`.
   ```typescript
   async function send(payload: object): Promise<void>
   ```
   Headers: `Content-Type: application/json`, `X-API-Key: <apiKey>`, `X-Edge-Rum-Version: <sdkVersion>`

   Retry schedule:
   - Attempt 1: immediate
   - Attempt 2: 2 000ms
   - Attempt 3: 8 000ms
   - Attempt 4: 30 000ms → push to `OfflineQueue`

   Retry on: status `0`, `429` (respect `Retry-After` header), `503`.
   Never retry: other `4xx` — discard, `console.warn('[edge-rum]', ...)` in debug mode only.
   Add `X-Edge-Retry: <n>` header on retry attempts.
   Call `SessionManager.onSendSuccess()` after confirmed 2xx to increment `session.sequence`.

4. Write integration test against mock ingest server. Assert:
   - `Content-Type: application/json`
   - `X-API-Key` header present and starts with `"edge_"`
   - Body parses as valid JSON
   - `body.data.type === "batch"`
   - `body.data.events[0].type === "event"`
   - All attribute values are `string | number | boolean` — no objects or arrays
   - Body contains none of: `traceId`, `spanId`, `resourceSpans`, `instrumentationScope`, `opentelemetry`

---

### Task 1.4 — SessionManager and ID generation

#### Steps

1. Create `src/session/SessionIdGenerator.ts`.

   ID format matches the Android SDK pattern:
   ```
   device.id:   "device_{Date.now()}_{8hexchars}_{platform}"
   session.id:  "session_{Date.now()}_{8hexchars}_{platform}"
   user.id:     "user_{Date.now()}_{8hexchars}"
   ```

   8-char hex: `crypto.getRandomValues(new Uint8Array(4))` converted to hex string.
   `platform`: `"ios"` / `"android"` from Capacitor, or `"web"` in browser.

   Device ID persistence: stored in `localStorage` key `edge_rum_device_id`. Generated
   once per device installation. On native, derived from SHA-256 of `Device.getId()`.

2. Create `src/session/SessionManager.ts`. Singleton holding all mutable SDK state.

   Key fields:
   ```typescript
   deviceId: string
   sessionId: string
   sessionStartTime: string      // ISO 8601
   sequence: number              // increments per successful send
   lastActiveAt: number          // Unix ms — for session expiry check
   currentRoute: string          // updated by RouterCapture
   isOnline: boolean             // updated by NetworkCapture
   userId?: string               // set by EdgeRum.identify()
   appContext: AppContext
   deviceContext: DeviceContext
   networkContext: NetworkContext
   userContext?: UserContext
   ```

   `getContextAttributes()`: returns the full flat object merged onto every event.
   Checks session expiry on each call: if `Date.now() - lastActiveAt > 30 * 60 * 1000`
   → generate new `sessionId`, reset `sequence` to 0.

   `onSendSuccess()`: increments `sequence` — called by `RetryTransport` after 2xx.

3. Write tests:
   - Device ID persists across reinstantiation (mock localStorage)
   - Session expires after 30 minutes → new `sessionId`, `sequence` resets to 0
   - `sequence` increments only after `onSendSuccess()`
   - `getContextAttributes()` returns only primitive values — never objects

---

### Task 1.5 — HTTP request capture

#### Steps

1. Install:
   ```
   @opentelemetry/instrumentation-fetch
   @opentelemetry/instrumentation-xml-http-request
   ```

2. Create `src/instrumentation/requests.ts`. Register both instrumentations internally.

   Configuration:
   - `ignoreUrls`: always exclude `config.endpoint` — prevents recursive capture
   - `applyCustomAttributesOnSpan` hook:
     - Strip PII query params: regex remove `(token|email|phone|key|secret|password|auth)=[^&]*`
     - Apply `config.sanitizeUrl(url)` if provided
     - Detect GraphQL: if POST body contains `"operationName"`, extract as `network.graphql_operation`

   On span completion, call `recordEvent('network_request', {...})` with:
   ```
   network.url                  string   sanitised URL
   network.method               string   GET / POST / etc.
   network.status_code          number   HTTP status code
   network.duration_ms          number   round-trip ms
   network.request_body_size    number   bytes
   network.response_body_size   number   bytes
   network.parent_screen        string   SessionManager.currentRoute at time of request
   network.graphql_operation    string   if detected (optional)
   ```

3. Write tests:
   - `fetch()` to mock URL → `network_request` event in outgoing batch
   - `?token=abc` stripped from `network.url`
   - SDK's own ingest endpoint is NOT captured
   - GraphQL `operationName` appears as `network.graphql_operation`

#### References
- Fetch instrumentation: https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/plugins/web/opentelemetry-instrumentation-fetch
- XHR instrumentation: https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/plugins/web/opentelemetry-instrumentation-xml-http-request

---

### Task 1.6 — Public EdgeRum API

#### Steps

1. Create `src/types.ts` — all public-facing interfaces. Zero internal terms.

   ```typescript
   interface EdgeRumConfig {
     apiKey: string;                // required — must start with "edge_"
     endpoint?: string;             // default: https://edgetelemetry.ncgafrica.com/collector/telemetry
     appName?: string;              // app.name in all events
     appVersion?: string;           // app.version in all events
     appPackage?: string;           // app.package e.g. "com.yourco.app"
     environment?: 'production' | 'staging' | 'development';
     sampleRate?: number;           // 0.0–1.0, default 1.0
     ignoreUrls?: (string | RegExp)[];
     maxQueueSize?: number;         // offline cap, default 200
     flushIntervalMs?: number;      // send interval ms, default 5000
     batchSize?: number;            // events per batch, default 30
     sanitizeUrl?: (url: string) => string;
     debug?: boolean;
   }

   interface UserContext {
     id: string;
     [key: string]: string | number | boolean;
   }

   interface RumTimer {
     end(attributes?: Record<string, string | number | boolean>): void;
   }
   ```

2. Create `src/EdgeRum.ts`.

   `init(config)`: validate apiKey (throw if blank or not `"edge_"` prefix), guard double-init,
   call `SessionManager.start()`, `initPipeline()`, `registerRequestCapture()`.

   `identify(user)`: store in `SessionManager`. All subsequent events include `user.id`
   and any additional user attributes flattened into `attributes`.

   `track(name, attributes?)`: call `recordEvent('custom_event', { 'event.name': name, ...prefixed })`.
   PayloadBuilder prefixes custom attributes with `event.`.

   `time(name)`: records `startTime = Date.now()`, returns `{ end(attrs?) }`.
   On `.end()`: calls `recordEvent('custom_metric', { 'metric.name': name, 'metric.value': elapsed, 'metric.unit': 'ms', ...prefixed })`.

   `captureError(error, context?)`: calls `recordEvent('app.crash', { exception_type, message, stacktrace, is_fatal: false, handled: true, cause: 'HandledError', error_context: 'screen:' + currentRoute, runtime: 'webview' })`.
   Calls `flushPipeline()` immediately — errors are not deferred to the batch interval.

   `disable()`: sets `SessionManager.disabled = true`, clears offline queue.
   `enable()`: sets `disabled = false`, triggers `OfflineQueue.flush()`.
   `getSessionId()`: returns `SessionManager.sessionId`.

3. Create `src/index.ts`:
   ```typescript
   export { EdgeRum } from './EdgeRum';
   export type { EdgeRumConfig, UserContext, RumTimer } from './types';
   ```
   Nothing else. No internal imports. No OTel types.

4. Write tests for every public method with their exact error message strings.

---

## Phase 2 — Signals: Web Vitals, Errors, Page Load

**Goal:** LCP, INP, CLS, FCP, TTFB, JS errors, unhandled rejections, and WebView
page load timing captured and sent as correctly shaped events.

---

### Task 2.1 — Web Vitals capture

#### Steps

1. Install `web-vitals@^4` in `packages/core`.

2. Create `src/instrumentation/vitals.ts`. Subscribe to `onLCP`, `onINP`, `onCLS`,
   `onFCP`, `onTTFB` from `web-vitals`.

   For each callback, call `recordEvent('performance', {...})` with:
   ```
   performance.metric_name   string   "LCP" | "INP" | "CLS" | "FCP" | "TTFB"
   performance.value         number   raw value (ms for timing, score for CLS)
   performance.unit          string   "ms" or "score"
   performance.rating        string   "good" | "needs-improvement" | "poor"
   performance.screen        string   SessionManager.currentRoute
   ```

   Batched with other events — no immediate flush needed.

3. Tests: mock `PerformanceObserver` → `performance` event in outgoing batch.
   All `performance.*` attribute values are primitives.

#### References
- web-vitals v4: https://github.com/GoogleChrome/web-vitals

---

### Task 2.2 — Error capture

#### Steps

1. Create `src/instrumentation/errors.ts`.

2. `window.addEventListener('error', handler)`:
   - Extract `event.error.name` → `exception_type`, `event.message` → `message`,
     `event.error.stack` → `stacktrace`
   - Call `recordEvent('app.crash', { exception_type, message, stacktrace, is_fatal: false, handled: false, cause: 'UnhandledError', error_context: 'screen:' + currentRoute, runtime: 'webview' })`
   - Call `flushPipeline()` immediately

3. `window.addEventListener('unhandledrejection', handler)`:
   - Extract reason from `PromiseRejectionEvent`
   - `exception_type: 'UnhandledRejection'`, `cause: 'PromiseRejection'`
   - Same `recordEvent()` + immediate flush

4. Field names match Android SDK v2.0.0 exactly:
   `exception_type`, `message`, `stacktrace`, `is_fatal`, `handled`, `error_context`, `cause`
   Plus web-only: `runtime: 'webview'`

5. All error capture wrapped in try/catch — never let handler errors propagate to user code.

6. Tests: simulate `window.error` → `app.crash` with `handled: false`.
   Simulate rejection → `exception_type: 'UnhandledRejection'`.
   Verify `flushPipeline()` called immediately.

---

### Task 2.3 — Page load capture

#### Steps

1. Install `@opentelemetry/instrumentation-document-load` in `packages/core`.

2. Create `src/instrumentation/pageload.ts`. Register instrumentation internally.

   On load span completion, extract from `PerformanceNavigationTiming`:
   ```typescript
   recordEvent('page_load', {
     'page.ttfb_ms': timing.responseStart - timing.requestStart,
     'page.dom_content_loaded_ms': timing.domContentLoadedEventEnd - timing.startTime,
     'page.load_duration_ms': timing.loadEventEnd - timing.startTime,
     'page.resource_count': performance.getEntriesByType('resource').length,
     'page.route': window.location.pathname,
   });
   ```

   Note: `page_load` is web-only. Backend must add — see `docs/backend-changes.md` Change 4a.

3. Tests: mock `PerformanceNavigationTiming` → `page_load` event with correct attributes.

#### References
- document-load instrumentation: https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/plugins/web/opentelemetry-instrumentation-document-load

---

## Phase 3 — Native: Capacitor Device and Lifecycle

**Goal:** Device model, OS, battery, network type, and lifecycle events enrich every payload
with the same context the Android SDK provides.

---

### Task 3.1 — Device context

#### Steps

1. Create `packages/capacitor/src/DeviceContext.ts`.

2. Every Capacitor call guarded with:
   ```typescript
   if (!Capacitor.isNativePlatform()) { return webFallback(); }
   const { Device } = await import('@capacitor/device');
   ```

3. Collect and store in `SessionManager.deviceContext`:
   - `Device.getInfo()` → `device.model`, `device.manufacturer`, `device.platform`,
     `device.os`, `device.osVersion`, `device.isVirtual`
   - `Device.getBatteryInfo()` → `device.batteryLevel`, `device.batteryCharging`
   - `Device.getId()` → SHA-256 via `crypto.subtle.digest` → format to
     `device_{Date.now()}_{first8hexChars}_{platform}`
   - `window.screen.width/height` → `device.screenWidth`, `device.screenHeight`
   - `window.devicePixelRatio` → `device.pixelRatio`

4. Web fallback (non-native): parse `navigator.userAgent` for best-effort detection.
   Generate device ID from stored random suffix in `localStorage` key `edge_rum_device_id`.

5. Tests: native mock → attributes in `getContextAttributes()`.
   Non-native → falls back without throwing.
   Device ID matches `device_{ts}_{8hex}_{platform}` pattern.

#### References
- `@capacitor/device`: https://capacitorjs.com/docs/apis/device

---

### Task 3.2 — Network context and change events

#### Steps

1. Create `packages/capacitor/src/NetworkCapture.ts`.

2. On init: `Network.getStatus()` → store in `SessionManager.networkContext`.
   Supplement with `navigator.connection` for `network.effectiveType`, `network.downlinkMbps`.

3. `Network.addListener('networkStatusChange', callback)`:
   - Disconnect: `SessionManager.isOnline = false` → `RetryTransport` pushes to queue instead of sending
   - Reconnect: `SessionManager.isOnline = true` → trigger `OfflineQueue.flush()`
   - Either: `recordEvent('network_change', { 'network.connected', 'network.type', 'network.previous_type' })`

4. Tests: disconnect → `isOnline = false`. Reconnect → `OfflineQueue.flush()` called.
   `network_change` event has correct attributes.

#### References
- `@capacitor/network`: https://capacitorjs.com/docs/apis/network

---

### Task 3.3 — App lifecycle events

#### Steps

1. Create `packages/capacitor/src/LifecycleCapture.ts`.
   Record at top: `const MODULE_LOAD_TIME = Date.now()`.

2. `App.addListener('appStateChange', callback)`:

   `isActive: true` (foreground):
   - Check session expiry: `Date.now() - lastActiveAt > 30 * 60 * 1000` → `startNewSession()`
   - First foreground only: `coldStartMs = Date.now() - MODULE_LOAD_TIME`
   - `recordEvent('app_lifecycle', { 'lifecycle.event': 'foreground', 'lifecycle.cold_start_ms': coldStartMs })`
     Omit `cold_start_ms` on subsequent foregrounds.

   `isActive: false` (background):
   - `SessionManager.lastActiveAt = Date.now()`
   - `recordEvent('app_lifecycle', { 'lifecycle.event': 'background' })`
   - `flushPipeline()` with 3-second timeout via `Promise.race()`

3. Tests: cold start ms on first foreground only. Session renews after 30 min.
   `flushPipeline()` called on background.

#### References
- `@capacitor/app`: https://capacitorjs.com/docs/apis/app

---

### Task 3.4 — Native crash capture (post-MVP)

Deferred. Requires native Swift (iOS) and Kotlin (Android) plugin code.

When prioritised: register `NSUncaughtExceptionHandler` (iOS) and
`Thread.setDefaultUncaughtExceptionHandler` (Android). On crash, write to
`UserDefaults` / `SharedPreferences`. On next launch, read → emit `app.crash` with
`is_fatal: true`, `runtime: 'native'` → clear stored crash to prevent duplicates.

---

## Phase 4 — Angular and Ionic Instrumentation

**Goal:** Angular route changes, errors with component context, and Ionic page timing
captured with the correct `eventName` values.

---

### Task 4.1 — Angular module and standalone provider

#### Steps

1. Create `packages/angular/src/EdgeRumModule.ts`:
   ```typescript
   @NgModule({})
   export class EdgeRumModule {
     static forRoot(config: EdgeRumConfig): ModuleWithProviders<EdgeRumModule>
   }
   ```
   `forRoot()` registers `EdgeRum.init(config)` as `APP_INITIALIZER`, provides
   `EdgeRumService`, `RouterCapture`, `ErrorCapture`, `IonicLifecycleCapture`.

2. Export `provideEdgeRum(config: EdgeRumConfig)` for Angular 17+ standalone:
   ```typescript
   bootstrapApplication(AppComponent, {
     providers: [provideEdgeRum({ apiKey: 'edge_...', appVersion: '1.0.0' })]
   });
   ```

3. Create `packages/angular/src/EdgeRumService.ts` — `@Injectable` wrapper delegating
   to `EdgeRum.*` static methods. No logic of its own.

4. Tests: `forRoot()` returns valid `ModuleWithProviders`. `APP_INITIALIZER` calls `init()`.
   `provideEdgeRum()` works in `TestBed`.

#### References
- Angular `APP_INITIALIZER`: https://angular.dev/api/core/APP_INITIALIZER

---

### Task 4.2 — Router capture

#### Steps

1. Create `packages/angular/src/RouterCapture.ts`. Inject `Router`.

2. Subscribe to `Router.events`:
   - `NavigationStart` → record `{ startTime, fromRoute: SessionManager.currentRoute }`
   - `NavigationEnd` → `recordEvent('screen_view', {...})` with:
     ```
     navigation.from_screen    string   previous normalised route (null on first nav)
     navigation.to_screen      string   new normalised route pattern e.g. /products/:id
     navigation.method         string   "push" | "pop" | "replace" | "initial"
     navigation.route_type     string   "main_flow" | "deeplink" | "settings" | "modal"
     navigation.has_arguments  boolean  true if route has params or query string
     navigation.timestamp      string   ISO 8601
     navigation.duration_ms    number   NavigationEnd.ts - NavigationStart.ts
     ```
     Update `SessionManager.currentRoute` to normalised route.
   - `NavigationError` → `recordEvent('app.crash', { exception_type: 'NavigationError', ... })`
   - `NavigationCancel` → `recordEvent('screen_view', { navigation.method: 'cancel', ... })`

3. Route normalisation — critical for backend cardinality control:
   Walk `router.routerState.snapshot.root` recursively via `ActivatedRouteSnapshot.children`.
   Collect `routeConfig.path` segments, join with `/`. Store `/products/:id` never `/products/9876`.

4. Navigation method: `"initial"` on first session nav. `"pop"` when `popstate` fires.
   `"replace"` when `extras.replaceUrl === true`. `"push"` otherwise.

5. Tests: `/products/9876` stored as `/products/:id`. Duration is positive number.
   `NavigationError` produces `app.crash` event.

#### References
- Angular Router events: https://angular.dev/api/router/RouterEvent
- ActivatedRouteSnapshot: https://angular.dev/api/router/ActivatedRouteSnapshot

---

### Task 4.3 — Angular error capture

#### Steps

1. Create `packages/angular/src/ErrorCapture.ts` implementing Angular `ErrorHandler`.

2. `handleError(error)`:
   - Extract component name: match `ComponentName_Template_` pattern in stack trace
   - Call `EdgeRum.captureError(error, { component: componentName, cause: 'AngularError', error_context: 'screen:' + currentRoute })`
   - Forward to original `ErrorHandler` — Angular's `console.error` still fires

3. Register: `{ provide: ErrorHandler, useClass: EdgeRumErrorCapture }` in `forRoot()`.

4. Tests: intercepts `handleError`. `handled: true` in `app.crash` event.
   Component name extracted from sample Angular stack. Original handler still called.

#### References
- Angular `ErrorHandler`: https://angular.dev/api/core/ErrorHandler

---

### Task 4.4 — Ionic page lifecycle capture

#### Steps

1. Create `packages/angular/src/IonicLifecycleCapture.ts`.

2. Listen on `document` for Ionic's DOM events:
   `ionViewWillEnter`, `ionViewDidEnter`, `ionViewWillLeave`, `ionViewDidLeave`

3. `ionViewWillEnter` → store `{ screenName, t: Date.now() }`
4. `ionViewDidEnter` → `recordEvent('screen_timing', { 'screen.name': name, 'screen.event': 'enter', 'screen.duration_ms': delta })`
5. `ionViewWillLeave` → store `{ screenName, t: Date.now() }`
6. `ionViewDidLeave` → `recordEvent('screen_timing', { 'screen.name': name, 'screen.event': 'leave', 'screen.duration_ms': delta })`

   Note: `screen_timing` is web-only. Backend must handle — see `docs/backend-changes.md` Change 4b.

7. Tests: mock Ionic lifecycle events → `screen_timing` event with correct `screen.event` value.

---

## Phase 5 — Resilience: Offline Queue and Retry

**Goal:** Zero event loss during offline periods. Queue survives app restarts.

---

### Task 5.1 — Offline queue

#### Steps

1. Create `src/queue/OfflineQueue.ts`.

2. Storage: `@capacitor/preferences` key `edge_rum_q` on native. `localStorage` key `edge_rum_q` on web.
   Stored value: JSON array of stringified complete batch payload objects.

3. `push(payload: string)`: append, trim to `maxQueueSize` (default 200, FIFO eviction).
4. `flush(sendFn)`: sequential processing — success removes, failure keeps, stops remaining.
5. `size()`: for debug. `clear()`: called by `EdgeRum.disable()`.

6. Tests:
   - Push 250 with cap 200 → oldest 50 dropped
   - Failed `sendFn` → items remain, next items not attempted
   - Success → queue empties

#### References
- `@capacitor/preferences`: https://capacitorjs.com/docs/apis/preferences

---

### Task 5.2 — Flush triggers

#### Steps

1. App background (`isActive: false`): `flushPipeline()` with 3s timeout via `Promise.race()`.

2. Tab hidden (`visibilitychange`):
   ```typescript
   document.addEventListener('visibilitychange', () => {
     if (document.visibilityState === 'hidden') flushPipeline();
   });
   ```

3. Page unload (`beforeunload`): try `navigator.sendBeacon(endpoint, JSON.stringify(payload))`.
   iOS WKWebView fallback: synchronous `XMLHttpRequest` with `async: false`, 1s timeout.
   Detect iOS: `SessionManager.deviceContext.platform === 'ios'`.

4. Network reconnect: `OfflineQueue.flush()` from `NetworkCapture` (Task 3.2).

5. Tests: mock `visibilitychange` to hidden → `flushPipeline()` called.
   Mock reconnect → `OfflineQueue.flush()` called.

---

## Phase 6 — Distribution: npm, Docs, Demo

**Goal:** Publicly installable. Zero internal terminology visible anywhere consumers look.

---

### Task 6.1 — Bundle audit

#### Steps

1. Confirm `noExternal: [/@opentelemetry\/.*/]` in all `tsup.config.ts` files.
2. `npm pack --dry-run` — `node_modules/@opentelemetry` must not appear in file list.
3. Run terminology grep check manually — must return no matches.
4. Run attribute flatness check on all integration test payloads.
5. Confirm `size-limit` passes: core < 90KB gzipped, full stack < 200KB gzipped.

---

### Task 6.2 — Attribution and licensing

#### Steps

1. `pnpm dlx license-checker --production --out THIRD_PARTY_LICENSES`
2. Required: all bundled `@opentelemetry/*` packages (Apache 2.0), `web-vitals` (Apache 2.0).
3. Include in `files` array of each `package.json`.
4. Proprietary licence header in each source file.

---

### Task 6.3 — npm publish

#### Steps

1. Final package names: `@edgemetrics/rum`, `@edgemetrics/rum-angular`, `@edgemetrics/rum-capacitor`.
2. `publishConfig: { "access": "public" }` on each.
3. `.npmignore`: exclude `src/`, `test/`, `demo/`, `*.test.ts`, `tsup.config.ts`, `CLAUDE.md`.
4. GitHub Actions: publish on `v*.*.*` tag.
5. Test with `npm publish --dry-run` before first real release.

---

### Task 6.4 — Documentation

Consumer-facing docs use product language only — see `docs/terminology.md`.
Never mention OpenTelemetry, spans, traces, OTLP, or metrics.

**Quick start:**

```bash
npm install @edgemetrics/rum @edgemetrics/rum-angular @edgemetrics/rum-capacitor
```

```typescript
// app.module.ts
import { EdgeRumModule } from '@edgemetrics/rum-angular';

@NgModule({
  imports: [
    EdgeRumModule.forRoot({
      apiKey: 'edge_your_key_here',
      appVersion: '1.0.0',
      appName: 'MyApp',
      appPackage: 'com.yourco.app',
    })
  ]
})
export class AppModule {}
```

HTTP requests, route changes, performance data, and errors captured automatically.

**Doc pages to write:**
1. Quick start
2. Configuration reference — every `EdgeRumConfig` field
3. Identifying users — `EdgeRum.identify()`, what NOT to pass (no PII)
4. Custom events — `EdgeRum.track()` and `EdgeRum.time()`
5. Error capture — `EdgeRum.captureError()`
6. Backend integration — payload contract, endpoint, auth, CORS
7. Privacy and data — what is collected, URL sanitisation, consent management
8. Changelog

---

### Task 6.5 — Demo app

#### Steps

1. `ionic start edge-rum-demo blank --type=angular` in `demo/`.
2. Install and configure all three packages.
3. Add screens: route navigation, API calls, intentional error, custom event, offline simulation.
4. Add dev-only data viewer panel — last 20 JSON payloads sent, for verification and demos.
5. `docker-compose.yml` with minimal Node.js ingest server:
   - Accepts `POST /collector/telemetry`
   - Validates `X-API-Key`
   - Pretty-prints received payloads to stdout
   - Returns `200 OK`

---

## Cross-cutting concerns

**Sampling:** `sampleRate` (0.0–1.0, default 1.0) implemented internally. Errors always
bypass sampling — 100% capture. SDK's own ingest requests always excluded.

**PII and privacy:** Default URL sanitiser strips `token|email|phone|key|secret|password|auth`
query params. Override with `sanitizeUrl`. `user.id` must be an opaque internal ID — never
email or name. Device ID is SHA-256 derived — raw `Device.getId()` never stored or sent.
GDPR: `EdgeRum.disable()` stops all capture and clears queue.

**Debug mode:** `debug: true` logs all outgoing JSON to `console.debug`. API key
redacted in logs: `edge_****` (same behaviour as Android SDK).

---

## Backend checklist (for coordination with backend team)

Full details in `docs/backend-changes.md`.

**Blocking before any production testing:**
- [ ] CORS headers + OPTIONS preflight on `/collector/telemetry`
- [ ] `device.platform: "web"` handled in Kafka processor

**Blocking for launch:**
- [ ] `sdk.version`, `sdk.platform`, `session.sequence` do not cause payload rejection
- [ ] `app.crash` `runtime` field does not cause rejection

**Post-launch (scheduled work):**
- [ ] `page_load`, `screen_timing`, `network_change` eventNames stored and queryable
- [ ] `session.sequence` gap detection
- [ ] Source map upload endpoint + JS stack symbolication worker

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Internal OTel terms leak into `.d.ts` files | Medium | High | CI grep check — fails build |
| Zone.js double-patching → async context loss | High | High | `ZoneContextManager` — tested fix |
| Android SDK eventName mismatch in payload | Medium | High | Integration tests assert exact field values |
| Attribute value is an object not a primitive | Medium | High | TypeScript constraint + CI flatness assertion |
| WKWebView `sendBeacon` unreliable on iOS | High | Medium | Sync XHR fallback on `visibilitychange` |
| Backend CORS missing at test time | High | High | `demo/docker-compose.yml` mock server |
| Bundle exceeds 200KB gzipped | Medium | Medium | `size-limit` CI gate |
| `Capacitor.*` throws in browser | High | Low | `isNativePlatform()` guard on every call |
| PII captured in URL params | Medium | High | Default sanitiser + `sanitizeUrl` config |
| Offline queue grows unbounded | Low | Medium | Hard cap 200 + FIFO eviction |
| OTel JS major version change | Low | High | Pin to minor; quarterly upgrade review |
| JS stacks unreadable without source maps | High | Medium | Accepted for launch — backend symbolication is post-launch |

---

## Milestone summary

| Milestone | Deliverable | Phase |
|---|---|---|
| M1 | `network_request` batch events at backend in correct envelope | Phase 1 |
| M2 | Web Vitals, JS errors, page load events in backend | Phase 2 |
| M3 | Device model, OS, battery, network, lifecycle on all events | Phase 3 |
| M4 | Angular route changes as `screen_view` events | Phase 4 |
| M5 | Zero event loss after 10-minute offline simulation | Phase 5 |
| M6 | `npm install @edgemetrics/rum` works end-to-end against production backend | Phase 6 |

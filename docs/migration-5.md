# Upgrading from 4.x to 5.0

5.0 is a clean break: 4.x options are not accepted and there are no warnings for removed ones.
Follow the steps below in order. 4.x gets no further fixes once 5.0 is released.

## 1. Backend first

5.0 sends wire contract 4.0.0 with `sdk.name = "ionic"`. Ship a 5.0 build only once the Edge RUM
backend release that accepts it is live. On an older backend the data is rejected and lost.

App builds still on 4.x keep reporting after the backend update, until users update the app.

## 2. Install

```sh
npm install @nathanclaire/rum@5 @nathanclaire/rum-capacitor@5 @nathanclaire/rum-angular@5
npm uninstall @capacitor/device @capacitor/network   # if only edge-rum needed them
npx cap sync
```

- `@nathanclaire/rum-capacitor` is now **required**. The native plugin captures, stores and sends
  everything; there is no sending from JavaScript.
- The native plugin is now registered as `EdgeRum` (was `EdgeRumCapacitor`).
- `@capacitor/device` and `@capacitor/network` are no longer peers. `@capacitor/app` stays (optional).
- Angular 16 or later.

## 3. Move native settings to `capacitor.config.ts`

Settings needed before the WebView loads now live in `plugins.EdgeRum`
([full reference](./config-reference.md)):

```ts
// capacitor.config.ts
plugins: {
  EdgeRum: {
    apiKey: 'edge_xxx',
    endpoint: 'https://edgetelemetry.ncgafrica.com/collector/telemetry',
    sampleRate: 1.0,
  },
},
```

| 4.x option | 5.0 |
|---|---|
| `apiKey`, `endpoint` | `plugins.EdgeRum.apiKey` / `endpoint`. Still accepted by `init()` as a per-launch override |
| `sampleRate` | `plugins.EdgeRum.sampleRate` |
| `enableAnrDetection`, `anrTimeoutMs` | `plugins.EdgeRum.anr`, `anrTimeoutMs` |
| `enableHangDetection`, `hangTimeoutMs` | `plugins.EdgeRum.hang`, `hangTimeoutMs` (default now 2000 on both platforms) |
| `captureMemory`, `memorySamplingIntervalMs` | `plugins.EdgeRum.memorySampling`, `memorySamplingIntervalMs` |
| `captureNativeCrashes` | Gone: native crashes are always captured |
| `appName`, `appVersion`, `appPackage`, `appBuild` | Gone: read from the app binary |
| `environment` | Gone: use separate API keys per environment |
| `location`, `resolveLocation`, `locationProviderUrl` | Gone |
| `maxQueueSize`, `flushIntervalMs`, `batchSize`, `deferFlush`, `awaitNativeInstall` | Gone: sending is fixed and handled natively |
| `captureFrames`, `captureAllFrames`, `frameSlowThresholdMs` | `frames({ slowThresholdMs })` capture |
| `captureConsoleErrors` | `consoleErrors()` capture |
| any other `captureX: boolean` | The matching capture in `captures` (below) |
| `ignoreUrls`, `sanitizeUrl`, `debug` | Unchanged, in `init()` |
| — | New in `init()`: `captures`, `traceHostAllowlist`, `beforeSend`, `release` |

## 4. Choose captures

Optional captures are imported functions instead of booleans:

```ts
import { defaultCaptures } from '@nathanclaire/rum-capacitor';
import { resourceTiming } from '@nathanclaire/rum';

provideEdgeRum({ captures: [...defaultCaptures(), resourceTiming()] });
```

`provideEdgeRum()` already uses `defaultCaptures()` (Web Vitals, taps, frames, long tasks, console
errors, plugin call timings). Resource timing is now off by default. See
[config-reference](./config-reference.md#init-options).

## 5. Angular

```ts
// 4.x
EdgeRumModule.forRoot({ apiKey, endpoint, appName: 'MyApp', environment: 'production' })

// 5.0 — standalone
bootstrapApplication(AppComponent, { providers: [provideRouter(routes), provideEdgeRum()] });

// 5.0 — NgModule
imports: [EdgeRumModule.forRoot()]
```

- `provideEdgeRum()` is the primary API; `EdgeRumModule.forRoot()` wraps it.
- Your own `ErrorHandler` keeps working: edge-rum reports the error, then calls yours.
- No longer exported: `RouterCapture`, `IonicLifecycleCapture`, `EdgeRumErrorCapture`,
  `EDGE_RUM_CONFIG`, `edgeRumInitializerFactory`, `ERROR_ROUTE_PROVIDER`, `LIFECYCLE_EVENT_SOURCE`,
  `SDK_PLATFORM`. They're wired by `provideEdgeRum()`.
- From `@nathanclaire/rum-capacitor`: `startCapacitorCapture`, `getDeviceContext`,
  `startNetworkCapture`, `startLifecycleCapture`, `createCapacitorHttpFetch` are gone. The plugin
  does this itself.

## 6. API

| 4.x | 5.0 |
|---|---|
| `EdgeRumConfig` type | `EdgeRumOptions` |
| `init(config)` throws on a bad config | Never throws; debug warning only |
| `getSessionId(): string` | `getSessionId(): Promise<string>` — `await` it |
| `identify({ name, email, phone })` | `identify({ id, name, email, phone })`; `clearUser()` added |
| `UserContext` type | `UserTraits` |
| — | New: `measure`, `startTask` / `completeTask` / `failTask`, `markReady`, `setAttribute` / `removeAttribute`, `reset` |

`track`, `time`, `trackScreen`, `captureError`, `enable`, `disable` are unchanged.

## 7. Web

On web (`ionic serve`, PWA builds) 5.0 captures and sends nothing. Every method is a silent no-op.
4.x sent `device.platform = web` rows; those stop.

## 8. Data continuity

Expect a step in your dashboards at the upgrade:

- **New ids.** Each device gets a new `device_id` and user id on its first 5.0 launch; 4.x ids are
  deleted, not carried over. Devices and users are counted twice across the upgrade window.
- **Renamed events and keys.** Update saved queries and alerts:

| 4.x | 5.0 |
|---|---|
| `page_load`, `lifecycle.cold_start_ms` | `app.start` |
| `user.interaction` | `ui.interaction` |
| `frame_render_time` | `frame.summary` |
| `app.crash` with `cause=ANR` / `cause=Hang` | `app.anr` / `app.hang` |
| memory keys without a dot | `memory.*` |
| `metric.screen` | `screen.name` |
| `lifecycle.event` | `lifecycle.state` |
| battery keys in camelCase | snake_case |
| `device.platform = web` | not sent (step 7) |

The full 5.0 list: [events.md](./events.md).

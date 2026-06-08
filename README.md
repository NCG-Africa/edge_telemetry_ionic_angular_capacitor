# Edge RUM SDK

Real User Monitoring SDK for **Ionic Angular Capacitor** apps. Captures user journey, errors, performance, native crashes, and interactions automatically — then ships them as JSON to your backend.

**Current version:** 3.5.0 · **Wire contract:** 3.1.0

## Packages

| Package | Description |
|---|---|
| [`@nathanclaire/rum`](./packages/core) | Core SDK — event capture, batching, transport, session management |
| [`@nathanclaire/rum-angular`](./packages/angular) | Angular integration — module / standalone provider, service, router + Ionic lifecycle + ErrorHandler |
| [`@nathanclaire/rum-capacitor`](./packages/capacitor) | Capacitor integration — device info, network, app lifecycle, **native crash bridge (iOS PLCrashReporter + Android JVM/ANR/NDK)** |

## What it captures automatically

Zero further wiring beyond the install — every line below works out of the box:

- **User journey:** Angular navigations, Ionic screen exits with full dwell time, click / tap interactions (tag/id/class/role, never inner text), session lifecycle (`session.started` / `session.finalized` with visited-screens list + counters)
- **Network:** every `fetch` / XHR with method, status, duration, success flag; SDK's own endpoint auto-ignored
- **Performance:** all five Web Vitals (`LCP`, `FCP`, `INP`, `CLS`, `TTFB`) as metric items; long tasks > 50 ms; resource timing for images/fonts/css/scripts; page load timing
- **Errors:** unhandled JS errors, promise rejections, `console.error`/`warn` (configurable), `EdgeRum.captureError()` for handled errors. Every crash carries a 20-item breadcrumb ring of preceding user actions.
- **Native crashes (Capacitor):**
  - iOS: NSException + Mach signals (SIGSEGV/SIGBUS/SIGILL/SIGFPE/SIGABRT) via PLCrashReporter
  - iOS: main-thread hangs > 5 s (configurable)
  - Android: uncaught Java/Kotlin `Throwable` via chained `Thread.setDefaultUncaughtExceptionHandler`
  - Android: ANRs > 5 s (configurable)
  - Android: NDK signal handler (async-signal-safe sigaction) for native code crashes
- **Device + network context:** OS, model, screen, battery, network type, connectivity changes — auto-attached to every event
- **Session counters:** `is_first_session`, `total_sessions` (cross-launch via localStorage)

## Installation

```bash
npm install @nathanclaire/rum @nathanclaire/rum-angular @nathanclaire/rum-capacitor
npx cap sync ios
npx cap sync android
```

## Step-by-Step Setup

### Step 1 — Configure the Angular module

Choose **one** of the two approaches below depending on whether your app uses `NgModule` or standalone components.

**NgModule approach** (`app.module.ts`):

```typescript
import { EdgeRumModule } from '@nathanclaire/rum-angular';

@NgModule({
  imports: [
    EdgeRumModule.forRoot({
      apiKey: 'edge_your_api_key_here',
      endpoint: 'https://your-collector.example.com/collector/telemetry',
      appName: 'MyApp',
      appVersion: '1.0.0',
      appPackage: 'com.yourco.app',
      appBuild: '210',
      environment: 'production',
      deferFlush: true,
    }),
  ],
})
export class AppModule {}
```

**Standalone approach** (`app.config.ts`):

```typescript
import { provideEdgeRum } from '@nathanclaire/rum-angular';

export const appConfig: ApplicationConfig = {
  providers: [
    provideEdgeRum({
      apiKey: 'edge_your_api_key_here',
      endpoint: 'https://your-collector.example.com/collector/telemetry',
      appName: 'MyApp',
      appVersion: '1.0.0',
      appPackage: 'com.yourco.app',
      appBuild: '210',
      environment: 'production',
      deferFlush: true,
    }),
  ],
};
```

> **`deferFlush: true`** is recommended for Capacitor apps. It tells the SDK to buffer events until device context (device ID, platform, OS version, app build number) is fully loaded, preventing the first batch from going out with placeholder identity attributes.

### Step 2 — Start Capacitor capture

In your root component, call `startCapacitorCapture()` to enable device-context loading, network capture, lifecycle hooks, and the native crash bridge:

```typescript
import { Component, OnInit, OnDestroy } from '@angular/core';
import {
  startCapacitorCapture,
  type CapacitorCaptureHandle,
} from '@nathanclaire/rum-capacitor';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
})
export class AppComponent implements OnInit, OnDestroy {
  private captureHandle?: CapacitorCaptureHandle;

  async ngOnInit() {
    this.captureHandle = await startCapacitorCapture();
  }

  async ngOnDestroy() {
    await this.captureHandle?.stop();
  }
}
```

`startCapacitorCapture()` registers the native crash bridge by default. You can opt out:

```typescript
await startCapacitorCapture({
  captureNativeCrashes: false,    // skip the iOS/Android native bridge entirely
  enableAnrDetection: false,      // Android — disable main-thread ANR watchdog
  enableHangDetection: false,     // iOS — disable main-thread hang watchdog
});
```

### Step 3 — You're done

The SDK now captures everything in the [auto-instrumentation catalog](./docs/TECHNICAL_GUIDE.md#2-automatic-capture-catalog) without further code.

## Custom events and identification

```typescript
import { EdgeRumService } from '@nathanclaire/rum-angular';

@Component({ /* ... */ })
export class CheckoutPage {
  constructor(private rum: EdgeRumService) {}

  onLoad() {
    // Attach user identity after login
    this.rum.identify({ name: 'Alice', email: 'alice@example.com' });
  }

  onCheckoutStart(amount: number) {
    this.rum.track('checkout_started', { amount, currency: 'GBP' });
  }

  async onImageUpload(file: File) {
    const timer = this.rum.time('image_upload');
    try {
      await uploadImage(file);
      timer.end({ file_size_kb: file.size / 1024 });
    } catch (err) {
      this.rum.captureError(err as Error, { step: 'upload' });
    }
  }

  openCheckoutModal() {
    // Manual screen tracking for modals / tabs that don't use Angular Router.
    // Also emits screen.duration for the previous tracked screen.
    this.rum.trackScreen('CheckoutModal');
  }
}
```

## Configuration

All options are documented in [docs/config-reference.md](./docs/config-reference.md). Common ones:

| Option | Default | Notes |
|---|---|---|
| `apiKey`, `endpoint` | *required* | `apiKey` must start with `'edge_'` |
| `appName`, `appVersion`, `appPackage`, `appBuild`, `environment`, `location` | various | identity context |
| `sampleRate` | `1.0` | **Per-session, not per-event.** Critical events (`app.crash`, `session.*`, `user.profile.update`) bypass. |
| `captureConsoleErrors` | `true` | Wraps `console.error`/`warn` to emit `app.crash` |
| `captureNativeCrashes` | `true` | Capacitor only — register the native bridge |
| `enableAnrDetection`, `enableHangDetection`, `anrTimeoutMs`, `hangTimeoutMs` | enabled, 5000 ms | Native-bridge config |
| `ignoreUrls`, `sanitizeUrl` | — | Network capture filtering |
| `flushIntervalMs`, `batchSize`, `maxQueueSize` | 5000 ms / 30 / 200 | Transport tuning |
| `debug` | `false` | Logs every event + every internal error. API key redacted. |

## API Reference

### EdgeRumService (Angular DI wrapper around `EdgeRum`)

| Method | Description |
|---|---|
| `identify(user)` | Attach name/email/phone. Emits `user.profile.update`. Pass `null` to clear a field. |
| `track(name, attributes?)` | Record a custom event (`custom_event`) |
| `trackScreen(name, attributes?)` | Manually mark a screen transition (modal, tab, etc.). Emits `navigation` + `screen.duration` for the previous screen. |
| `time(name)` | Start a timer. Returns `{ end(attributes?) }`. Emits a metric item with `metricName` and `value` (duration in ms). |
| `captureError(error, context?)` | Manually capture an error (`app.crash` with `handled: true`, `cause: 'ManualCapture'`) |
| `disable()` | Stop capturing and clear the offline queue |
| `enable()` | Resume capturing and flush queued events |
| `getSessionId()` | Get the current session ID string |

## Offline support

Events that fail to send are stored in an offline queue (localStorage on web, sessionStorage fallback in private modes). They retry automatically when:

- The device comes back online (Capacitor `Network` plugin reconnect)
- The app returns to the foreground (Capacitor `App` plugin)
- `EdgeRum.enable()` is called
- **Any** successful live send completes (opportunistic drain — the queue self-heals from transient outages without needing one of the explicit triggers)

Retry schedule: immediate → 2 s → 8 s → 30 s → offline queue. Retries on HTTP `0`, `429` (respects `Retry-After`), `503`. Discards on other 4xx.

## Session management

- Session id format: `session_{Date.now()}_{16hexchars}_{platform}` (e.g. `session_1716624000000_a8b9c2d176b4ce41_ios`)
- Platform detected synchronously from `window.Capacitor.getPlatform()` — falls back to `'web'`
- Sessions expire after 30 minutes of background idle
- Background fires `session.finalized { end_reason: 'backgrounded' }`; subsequent foreground fires `session.started` with `start_reason: 'resumed'` (within timeout) or `'rotation_timeout'` (after)
- App close (pagehide / beforeunload) ships `session.finalized { end_reason: 'app_closed' }` via `navigator.sendBeacon` (or sync XHR on iOS)
- Every `session.finalized` carries the **journey summary**: `visited_screens` (comma-separated), `screen_count`, `event_count`, `metric_count`, `journey_truncated`

## Disabling the SDK

```typescript
this.rum.disable();   // Stop capturing + clear offline queue
this.rum.enable();    // Resume + flush
```

## Documentation

- **[docs/TECHNICAL_GUIDE.md](./docs/TECHNICAL_GUIDE.md)** — the authoritative technical reference (auto-capture catalog, lifecycle, sampling, native bridge, debugging)
- [docs/quick-start.md](./docs/quick-start.md) — five-minute wire-up
- [docs/config-reference.md](./docs/config-reference.md) — every `EdgeRumConfig` option
- [docs/backend-integration.md](./docs/backend-integration.md) — endpoint, auth, CORS, wire contract
- [docs/payload-schema.json](./docs/payload-schema.json) — machine-readable wire contract
- [docs/decisions.md](./docs/decisions.md) — architecture decision log (ADRs)
- [docs/privacy.md](./docs/privacy.md) — what is collected and what isn't
- [docs/terminology.md](./docs/terminology.md) — terminology firewall (internal)

## License

[MIT](./LICENSE)

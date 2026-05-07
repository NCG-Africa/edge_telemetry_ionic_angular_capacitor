# Edge RUM SDK

Real User Monitoring SDK for **Ionic Angular Capacitor** apps. Captures performance data, errors, network requests, and user interactions automatically — then ships them as JSON to your backend.

## Packages

| Package | Description |
|---|---|
| [`@nathanclaire/rum`](./packages/core) | Core SDK — event capture, batching, transport |
| [`@nathanclaire/rum-angular`](./packages/angular) | Angular integration — module, service, route and error capture |
| [`@nathanclaire/rum-capacitor`](./packages/capacitor) | Capacitor integration — device info, network, lifecycle |

## Installation

```bash
npm install @nathanclaire/rum @nathanclaire/rum-angular @nathanclaire/rum-capacitor
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
      environment: 'production',
      deferFlush: true,
    }),
  ],
};
```

> **`deferFlush: true`** is recommended for Capacitor apps. It tells the SDK to buffer events until device context (device ID, platform, etc.) is fully loaded, preventing the first batch from being rejected by the server.

### Step 2 — Start Capacitor capture

In your root component (e.g. `app.component.ts`), call `startCapacitorCapture()` to collect device info, network status, and lifecycle events:

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

Once `startCapacitorCapture()` resolves, the SDK starts sending batches. All events recorded during startup are buffered and included in the first batch.

### Step 3 — You're done

The SDK now automatically captures:

| What | Event Name | How |
|---|---|---|
| Angular route changes | `screen_view` | Angular Router subscription |
| HTTP requests | `network_request` | Fetch/XHR interception |
| JS errors | `app.crash` | Angular `ErrorHandler` |
| Web Vitals (LCP, INP, CLS, FCP, TTFB) | `performance` | `web-vitals` library |
| Page load timing | `page_load` | Performance API |
| Ionic page transitions | `screen_timing` | Ionic lifecycle events |
| App foreground/background | `app_lifecycle` | Capacitor App plugin |
| Network connectivity changes | `network_change` | Capacitor Network plugin |

No extra code is needed for any of the above.

## Custom Events and Metrics

For app-specific tracking, inject `EdgeRumService` into your components:

```typescript
import { EdgeRumService } from '@nathanclaire/rum-angular';

@Component({ /* ... */ })
export class CheckoutPage {
  constructor(private rum: EdgeRumService) {}
}
```

### Track a custom event

```typescript
this.rum.track('checkout_started', {
  'event.value': 49.99,
  'event.currency': 'GBP',
});
```

### Measure a duration

```typescript
const timer = this.rum.time('image_upload');
await uploadImage(file);
timer.end({ 'metric.file_size_kb': file.size / 1024 });
// Records a custom_metric event with elapsed time in milliseconds
```

### Capture a handled error

```typescript
try {
  await riskyOperation();
} catch (error) {
  this.rum.captureError(error as Error, { operation: 'riskyOperation' });
}
```

### Identify a user

Call `identify()` after login to attach user attributes to all subsequent events:

```typescript
this.rum.identify({
  id: 'user_123',
  plan: 'premium',
  region: 'eu-west',
});
```

## Configuration Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | *required* | API key. Must start with `"edge_"` |
| `endpoint` | `string` | *required* | Collector endpoint URL |
| `appName` | `string` | — | App name attached to all events |
| `appVersion` | `string` | — | App version string |
| `appPackage` | `string` | — | Bundle ID, e.g. `com.yourco.app` |
| `environment` | `string` | — | `"production"`, `"staging"`, or `"development"` |
| `sampleRate` | `number` | `1.0` | Event sampling rate (0.0–1.0) |
| `ignoreUrls` | `(string \| RegExp)[]` | `[]` | URLs to exclude from request capture |
| `maxQueueSize` | `number` | `200` | Max offline queue size |
| `flushIntervalMs` | `number` | `5000` | Batch send interval in ms |
| `batchSize` | `number` | `30` | Max events per batch |
| `sanitizeUrl` | `(url: string) => string` | — | Strip PII from captured URLs |
| `deferFlush` | `boolean` | `false` | Defer sending until `startCapacitorCapture()` completes |
| `debug` | `boolean` | `false` | Log SDK activity to console |

## API Reference

### EdgeRumService

| Method | Description |
|---|---|
| `track(name, attributes?)` | Record a custom event (`custom_event`) |
| `time(name)` | Start a timer. Returns `{ end(attributes?) }` (`custom_metric`) |
| `captureError(error, context?)` | Manually capture an error (`app.crash` with `handled: true`) |
| `identify(user)` | Set user identity and custom attributes |
| `disable()` | Stop capturing and clear the offline queue |
| `enable()` | Resume capturing and flush queued events |
| `getSessionId()` | Get the current session ID string |

## Offline Support

Events that fail to send are stored in an offline queue (localStorage on web, Capacitor Preferences on native). They are automatically retried when:

- The device comes back online
- The app returns to the foreground
- `enable()` is called

The retry schedule uses exponential backoff: immediate, 2s, 8s, 30s. After 4 attempts, events are moved to the offline queue.

## Session Management

- Sessions expire after **30 minutes** of inactivity
- A new session starts on the next app foreground event
- Session IDs follow the format: `session_{timestamp}_{8hex}_{platform}`

## Disabling the SDK

```typescript
// Temporarily disable (e.g. for opt-out)
this.rum.disable();

// Re-enable
this.rum.enable();
```

`disable()` stops all capture and clears the offline queue. `enable()` resumes capture and flushes any queued events.

## Documentation

- [Backend integration guide](./docs/backend-integration.md)
- [Payload schema](./docs/payload-schema.json)
- [Architecture decisions](./docs/decisions.md)

## License

[MIT](./LICENSE)

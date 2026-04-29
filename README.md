# edge-rum

Real User Monitoring SDK for **Ionic Angular Capacitor** apps. Captures performance data, errors, network requests, and user interactions automatically — then ships them as JSON to your backend.

## Packages

| Package | Description |
|---|---|
| [`@nathanclaire/rum`](./packages/core) | Core SDK — event capture, batching, transport |
| [`@nathanclaire/rum-angular`](./packages/angular) | Angular integration — module, service, route and error capture |
| [`@nathanclaire/rum-capacitor`](./packages/capacitor) | Capacitor integration — device info, network, lifecycle |

## Quick start

```bash
npm install @nathanclaire/rum @nathanclaire/rum-angular @nathanclaire/rum-capacitor
```

```typescript
// app.module.ts
import { EdgeRumModule } from '@nathanclaire/rum-angular';

@NgModule({
  imports: [
    EdgeRumModule.forRoot({
      apiKey: 'edge_your_api_key_here',
      appName: 'MyApp',
      appVersion: '1.0.0',
      appPackage: 'com.yourco.app',
      environment: 'production',
    }),
  ],
})
export class AppModule {}
```

That's it. The SDK automatically captures HTTP requests, route changes, web vitals, errors, app lifecycle, and network changes.

## What gets captured automatically

- HTTP requests (fetch)
- Angular route changes (`screen_view` events)
- Web performance data (LCP, INP, CLS)
- Unhandled errors and promise rejections
- Ionic page enter/leave timing
- App foreground/background transitions
- Network connectivity changes
- Device information (model, OS, battery, screen)

## Custom events

```typescript
import { EdgeRumService } from '@nathanclaire/rum-angular';

// Track a custom event
this.rum.track('checkout_started', { value: 49.99, currency: 'GBP' });

// Time an operation
const timer = this.rum.time('image_upload');
await uploadImage();
timer.end({ file_size_kb: 2048 });

// Capture a handled error
this.rum.captureError(new Error('payment declined'), { step: 'confirm' });
```

## Documentation

- [Quick start guide](./docs/quick-start.md)
- [Configuration reference](./docs/config-reference.md)
- [Privacy and data](./docs/privacy.md)
- [Backend integration](./docs/backend-integration.md)

## License

[MIT](./LICENSE)

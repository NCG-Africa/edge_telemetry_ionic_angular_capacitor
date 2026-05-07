# @nathanclaire/rum-angular

Angular integration for the edge-rum SDK. Provides an Angular module, DI service, and automatic capture of route changes, errors, and Ionic page lifecycle.

## Install

```bash
npm install @nathanclaire/rum @nathanclaire/rum-angular @nathanclaire/rum-capacitor
```

## Setup

```typescript
// app.module.ts
import { EdgeRumModule } from '@nathanclaire/rum-angular';

@NgModule({
  imports: [
    EdgeRumModule.forRoot({
      apiKey: 'edge_your_api_key_here',
      endpoint: 'https://your-collector.example.com/collector/telemetry',
      appName: 'MyApp',
      appVersion: '1.0.0',
      appPackage: 'com.yourco.app',
    }),
  ],
})
export class AppModule {}
```

## What it captures automatically

- Angular route changes as `screen_view` events
- Unhandled errors and promise rejections as `app.crash` events
- Ionic page enter/leave timing as `screen_timing` events

## Using the service

```typescript
import { EdgeRumService } from '@nathanclaire/rum-angular';

constructor(private rum: EdgeRumService) {}

onLogin(user: { id: string }) {
  this.rum.identify({ id: user.id });
}

onCheckout() {
  this.rum.track('checkout_started', { value: 49.99 });
}
```

## Peer dependencies

- `@angular/core` >= 16
- `@angular/router` >= 16
- `rxjs` >= 7

## License

[MIT](../../LICENSE)

# Quick start

Get edge-rum capturing data from your Ionic Angular Capacitor app in under five minutes.

## 1. Install

```bash
npm install @edgemetrics/rum @edgemetrics/rum-angular @edgemetrics/rum-capacitor
```

## 2. Initialise in your Angular app module

```typescript
// app.module.ts
import { NgModule } from '@angular/core';
import { EdgeRumModule } from '@edgemetrics/rum-angular';

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

That is all you need. From this point on, edge-rum automatically captures:

- HTTP requests (fetch and XHR)
- Angular route changes
- Web performance data (page load timing, responsiveness, layout stability)
- Unhandled JavaScript errors and promise rejections
- Ionic page enter / leave timing
- App foreground / background transitions
- Network connectivity changes
- Device information (model, OS, battery, screen size)

## 3. Identify the user (optional)

After a user signs in, attach a stable, opaque ID so sessions can be grouped.

```typescript
import { EdgeRumService } from '@edgemetrics/rum-angular';

constructor(private rum: EdgeRumService) {}

onLogin(user: { id: string }) {
  this.rum.identify({ id: user.id });
}
```

Never pass email addresses, phone numbers, or real names. Use an opaque internal ID.

## 4. Record custom events (optional)

```typescript
this.rum.track('checkout_started', { value: 49.99, currency: 'GBP' });

const timer = this.rum.time('image_upload');
await uploadImage();
timer.end({ file_size_kb: 2048 });

this.rum.captureError(new Error('payment declined'), { step: 'confirm' });
```

## 5. Verify events are arriving

Turn on debug logging while integrating:

```typescript
EdgeRumModule.forRoot({
  apiKey: 'edge_your_api_key_here',
  appName: 'MyApp',
  debug: true,
});
```

Each send is logged to `console.debug`. The API key is redacted to `edge_****`.

## Next steps

- [Configuration reference](./config-reference.md) — every option on `EdgeRumConfig`
- [Backend integration](./backend-integration.md) — endpoint, auth, and payload contract
- [Privacy and data](./privacy.md) — what is collected and how to control it

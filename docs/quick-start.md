# Quick start

Get edge-rum capturing data from your Ionic Angular Capacitor app in under five minutes.

## 1. Install

```bash
npm install @nathanclaire/rum @nathanclaire/rum-angular @nathanclaire/rum-capacitor
```

On native platforms, also sync Capacitor so the native crash bridge is wired:

```bash
npx cap sync ios
npx cap sync android
```

The Capacitor plugin uses PLCrashReporter on iOS — `pod install` happens automatically as part of `cap sync ios`.

## 2. Initialise in your Angular app module

```typescript
// app.module.ts
import { NgModule } from '@angular/core';
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
    }),
  ],
})
export class AppModule {}
```

That's all you need. From this point on, edge-rum automatically captures:

**Captured automatically (no further wiring required):**

- HTTP / fetch requests (`http.request`)
- Angular route changes (`navigation`)
- Ionic screen exits with full dwell time (`screen.duration`)
- Web Vitals as metric items (`LCP`, `FCP`, `INP`, `CLS`, `TTFB`)
- Long tasks > 50 ms (`long_task` metric) via `PerformanceObserver`
- Resource timings — images, fonts, css, fetch — (`resource_timing` metric)
- Click / tap interactions (`user.interaction`, with tag/id/class/role — no text)
- Unhandled errors + promise rejections (`app.crash`)
- `console.error` / `console.warn` (configurable)
- Native crashes (iOS PLCrashReporter, Android JVM/ANR/NDK signals) replayed on next launch
- iOS main-thread hangs > 5 s (`Hang`)
- Android ANRs > 5 s (`ANR`)
- App foreground / background (`app_lifecycle`)
- Network connectivity changes (`network_change`)
- Page load timing (`page_load`)
- Session lifecycle (`session.started`, `session.finalized`) with full user journey snapshot
- Device context — model, OS, screen, battery, manufacturer

The full catalog (with every attribute) is in [TECHNICAL_GUIDE.md](./TECHNICAL_GUIDE.md#2-automatic-capture-catalog).

## 3. Identify the user (optional but recommended)

After a user signs in, attach details so sessions and crashes can be grouped by user:

```typescript
import { EdgeRumService } from '@nathanclaire/rum-angular';

constructor(private rum: EdgeRumService) {}

onLogin(user: { name: string; email: string }) {
  this.rum.identify({ name: user.name, email: user.email });
}
```

`identify()` emits a `user.profile.update` event so the backend can populate `rum_users`. The SDK's stable anonymous `user.id` is preserved across the call — it's the same id from before identification, just with extra metadata attached.

To clear a field, pass `null`:

```typescript
this.rum.identify({ email: null });  // logout — remove email but keep stable id
```

## 4. Record custom events (optional)

```typescript
// Custom event with arbitrary attributes
this.rum.track('checkout_started', { value: 49.99, currency: 'GBP' });

// Custom timing — emits a metric item
const timer = this.rum.time('image_upload');
await uploadImage();
timer.end({ file_size_kb: 2048 });

// Capture a handled error
this.rum.captureError(new Error('payment declined'), { step: 'confirm' });

// Manually mark a screen transition (e.g. modal open) outside the Angular Router
this.rum.trackScreen('CheckoutModal', { 'navigation.method': 'push' });
```

`trackScreen()` also emits a `screen.duration` event for the **previous** screen if one was active — so a modal that opens and closes is automatically timed.

## 5. Verify events are arriving

Turn on debug logging while integrating:

```typescript
EdgeRumModule.forRoot({
  apiKey: 'edge_your_api_key_here',
  endpoint: 'https://your-collector.example.com/collector/telemetry',
  debug: true,
});
```

You'll see in the browser / Capacitor console:

```
[edge-rum] initialized { endpoint: '...' }
[edge-rum] recordEvent session.started { 'session.start_reason': 'init', ... }
[edge-rum] recordEvent navigation { 'navigation.to_screen': '/tabs/home', ... }
[edge-rum] recordEvent user.interaction { 'interaction.target_tag': 'BUTTON', ... }
```

The API key is redacted to `edge_****` in all log output.

## 6. Verify native crash capture (Capacitor only)

After running on a real device or emulator, force a native crash to confirm the bridge is wired:

```typescript
// iOS — throw an unrecoverable Swift error from a button handler
import { Capacitor } from '@capacitor/core';
if (Capacitor.isNativePlatform()) {
  // bridge through a custom plugin or via a fatalError trampoline
}

// Android — throw an uncaught RuntimeException from any onClick
throw new Error('crash-test');  // becomes a JVM crash via the webview bridge
```

Restart the app. The next batch should contain an `app.crash` event with `cause: 'NativeCrash'` and `runtime: 'native'`. If it doesn't, see the troubleshooting section in [TECHNICAL_GUIDE.md § 13](./TECHNICAL_GUIDE.md#13-debugging-missing-data).

## Next steps

- [TECHNICAL_GUIDE.md](./TECHNICAL_GUIDE.md) — the full technical reference
- [config-reference.md](./config-reference.md) — every option on `EdgeRumConfig`
- [backend-integration.md](./backend-integration.md) — endpoint, auth, CORS, wire contract
- [privacy.md](./privacy.md) — what is collected, what isn't, how to control it
- [decisions.md](./decisions.md) — architecture decisions (ADR log)

# edge-rum

Real User Monitoring for **Ionic Angular Capacitor** apps on Android and iOS: crashes, errors,
launch time, screens, requests, taps, Web Vitals, smoothness and native plugin call timings, sent to
Edge RUM.

**Version 5.0** · wire contract 4.0.0 · upgrading from 4.x: [migration guide](./docs/migration-5.md)

| Package | |
|---|---|
| [`@nathanclaire/rum`](./packages/core) | Core: `EdgeRum` API, WebView captures |
| [`@nathanclaire/rum-capacitor`](./packages/capacitor) | **Required.** Native plugin `EdgeRum`: identity, sessions, native crashes, storage and sending |
| [`@nathanclaire/rum-angular`](./packages/angular) | `provideEdgeRum()`, Router, Ionic page and `ErrorHandler` capture |

**Requirements:** Capacitor 5+ (Swift Package Manager installs need Capacitor 8), Android 7.0
(API 24)+, iOS 14+ (15+ with SPM), Angular 16+ for `-angular`. On web the SDK does nothing.

## Setup

> ⚠ The Edge RUM backend release for 5.0 must be live before you ship a build with this SDK.

**1. Install**

```sh
npm install @nathanclaire/rum @nathanclaire/rum-capacitor @nathanclaire/rum-angular
```

**2. Configure the plugin** in `capacitor.config.ts`, then `npx cap sync`:

```ts
plugins: {
  EdgeRum: {
    apiKey: 'edge_xxx',
    endpoint: 'https://edgetelemetry.ncgafrica.com/collector/telemetry',
  },
},
```

Capture starts when the app launches: native crashes, `app.start`, sessions and lifecycle work
before any JavaScript runs.

**3. Start the WebView side**

Angular (standalone):

```ts
import { provideEdgeRum } from '@nathanclaire/rum-angular';

bootstrapApplication(AppComponent, {
  providers: [provideRouter(routes), provideEdgeRum({ traceHostAllowlist: ['api.example.com'] })],
});
```

Angular (NgModule): `imports: [EdgeRumModule.forRoot({ … })]`.

Without Angular:

```ts
import { EdgeRum } from '@nathanclaire/rum';
import { defaultCaptures } from '@nathanclaire/rum-capacitor';

EdgeRum.init({ captures: defaultCaptures() });
// name screens from your router (Vue Router shown):
router.afterEach((to) => EdgeRum.trackScreen(to.matched.at(-1)?.path ?? to.path));
```

All options: [config reference](./docs/config-reference.md).

## API

Import `EdgeRum` from `@nathanclaire/rum`, or inject `EdgeRumService` (same methods) in Angular.
Every method returns immediately, is safe to call before the plugin is ready, and never throws.

```ts
EdgeRum.identify({ id: 'u_42', name, email, phone });
EdgeRum.clearUser();

EdgeRum.track('checkout.coupon_applied', { coupon: 'SPRING' });
EdgeRum.measure('cart.items', 3);
const t = EdgeRum.time('search'); /* … */ t.end({ results: 12 });

EdgeRum.startTask('checkout');
EdgeRum.completeTask('checkout');      // or failTask('checkout', 'card_declined')

EdgeRum.trackScreen('/settings');      // only without Angular Router
EdgeRum.captureError(err, { order_id: 'o_1' });
EdgeRum.markReady();                   // first screen usable: ends app.start

EdgeRum.setAttribute('plan', 'pro');   // added to every WebView row
EdgeRum.removeAttribute('plan');

EdgeRum.disable(); EdgeRum.enable(); EdgeRum.reset();
const sessionId = await EdgeRum.getSessionId();
```

Attribute values are `string | number | boolean`.

## Docs

- [Events](./docs/events.md) — everything that is sent
- [Configuration](./docs/config-reference.md) — plugin settings, `init()` options, captures, trace headers, OTA `release`, debugging
- [Privacy](./docs/privacy.md) — what's never collected, URL reduction, `beforeSend`, consent
- [Migration from 4.x](./docs/migration-5.md)
- [Changelog](./CHANGELOG.md)

## Contributing

`docs/spec.md` is the build spec and `docs/decisions.md` holds the ADRs. Before a PR:

```sh
pnpm lint && pnpm type-check && pnpm test && pnpm build
pnpm terminology-check && pnpm attribute-flatness-check && pnpm pack-audit && pnpm size
pnpm test:integration
```

Releases: [docs/release-checklist.md](./docs/release-checklist.md).

## License

[MIT](./LICENSE)

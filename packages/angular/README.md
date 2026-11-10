# @nathanclaire/rum-angular

Angular integration for edge-rum: `provideEdgeRum()` starts the SDK and captures Router
navigations (with guard, resolver and lazy-load timings), Ionic page durations and errors reaching
`ErrorHandler` (your own handler still runs).

```sh
npm install @nathanclaire/rum @nathanclaire/rum-capacitor @nathanclaire/rum-angular
```

```ts
import { provideEdgeRum } from '@nathanclaire/rum-angular';

bootstrapApplication(AppComponent, {
  providers: [provideRouter(routes), provideEdgeRum({ traceHostAllowlist: ['api.example.com'] })],
});
// NgModule apps: imports: [EdgeRumModule.forRoot({ … })]
```

```ts
constructor(private rum: EdgeRumService) {}
onLogin(u: User) { this.rum.identify({ id: u.id, name: u.name }); }
```

Exports: `provideEdgeRum`, `EdgeRumModule`, `EdgeRumService` (every `EdgeRum` method),
`ionicUi()` (overlay, tab, back and keyboard taps; off by default), types.

**Peers:** Angular ≥ 16 (`core`, `common`, `router`), `rxjs` ≥ 7, `@nathanclaire/rum`,
`@nathanclaire/rum-capacitor`.

Setup, API and docs: [edge-rum README](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/blob/main/README.md).

## License

[MIT](../../LICENSE)

# @nathanclaire/rum

Core of edge-rum, Real User Monitoring for Ionic Capacitor apps: the `EdgeRum` API and the
WebView captures (errors, requests, Web Vitals, taps, frames, long tasks).

Needs [`@nathanclaire/rum-capacitor`](https://www.npmjs.com/package/@nathanclaire/rum-capacitor):
the native plugin stores and sends everything. On web this package does nothing.

```sh
npm install @nathanclaire/rum @nathanclaire/rum-capacitor
```

```ts
import { EdgeRum } from '@nathanclaire/rum';
import { defaultCaptures } from '@nathanclaire/rum-capacitor';

EdgeRum.init({ captures: defaultCaptures() });
EdgeRum.track('checkout.started');
```

Exports: `EdgeRum`, captures `vitals()`, `interactions()`, `frames()`, `longTasks()`,
`resourceTiming()`, `consoleErrors()`, `defaultCaptures()`, and types `EdgeRumOptions`,
`EdgeRumEvent`, `BeforeSend`, `Capture`, `UserTraits`, `RumTimer`, `EventAttributes`,
`AttributeValue`.

Setup, API and docs: [edge-rum README](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/blob/main/README.md).

## License

[MIT](../../LICENSE)

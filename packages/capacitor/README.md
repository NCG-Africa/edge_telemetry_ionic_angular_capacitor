# @nathanclaire/rum-capacitor

Native plugin for edge-rum (registered as `EdgeRum`). **Required.** On Android and iOS it owns
identity, sessions, the on-device store and sending, and captures native crashes, ANRs, hangs, app
exits, WebView deaths, launch time, lifecycle, memory and network changes.

```sh
npm install @nathanclaire/rum @nathanclaire/rum-capacitor
npx cap sync
```

```ts
// capacitor.config.ts
plugins: {
  EdgeRum: {
    apiKey: 'edge_xxx',
    endpoint: 'https://edgetelemetry.ncgafrica.com/collector/telemetry',
  },
},
```

All plugin settings: [config reference](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/blob/main/docs/config-reference.md).

Exports: `bridge()` (timings of every Capacitor plugin call, as `bridge.summary`) and
`defaultCaptures()` (core's set plus `bridge()`).

**Peers:** `@capacitor/core` ≥ 5, `@capacitor/app` ≥ 5 (optional). **Platforms:** Android API 24+,
iOS 14+ (CocoaPods) or 15+ with Swift Package Manager (Capacitor 8).

Setup, API and docs: [edge-rum README](https://github.com/NCG-Africa/edge_telemetry_ionic_angular_capacitor/blob/main/README.md).

## License

[MIT](../../LICENSE)

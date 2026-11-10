# Configuration reference

edge-rum 5.0 has two places for settings:

- **`capacitor.config.ts` → `plugins.EdgeRum`**: read by the native plugin at launch, before any
  JavaScript runs. Anything that has to work before the WebView loads lives here.
- **`EdgeRum.init()` / `provideEdgeRum()`**: options for what the WebView captures.

## `capacitor.config.ts`

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.example.app',
  appName: 'Example',
  webDir: 'www',
  plugins: {
    EdgeRum: {
      apiKey: 'edge_xxx',
      endpoint: 'https://edgetelemetry.ncgafrica.com/collector/telemetry',
    },
  },
};
export default config;
```

Run `npx cap sync` after any change.

| Key | Type | Default | |
|---|---|---|---|
| `apiKey` | string | — | Your project key (`edge_…`). Without it (or `endpoint`) data is kept on the device and sent once both are known |
| `endpoint` | string | — | Ingest URL |
| `enabled` | boolean | `true` | `false` = capture nothing until `EdgeRum.enable()` (consent opt-in). After `enable()` / `disable()` the stored choice wins |
| `sampleRate` | number 0–1 | `1.0` | Share of sessions kept. Decided once per session; a session is kept or dropped as a whole |
| `hang` | boolean | `true` | Report main-thread hangs as `app.hang` |
| `hangTimeoutMs` | number | `2000` | Hang threshold |
| `anr` | boolean | `true` | Android only: report ANRs as `app.anr` |
| `anrTimeoutMs` | number | `5000` | ANR threshold |
| `memorySampling` | boolean | `false` | Periodic `memory_usage` readings (start / end of session and pressure are always on) |
| `memorySamplingIntervalMs` | number | `30000` | Interval; iOS rounds to whole seconds, minimum 1 s |

App name, package, version and build number are read from the app binary. They can't be set.

## `init()` options

```ts
import { EdgeRum, vitals, interactions } from '@nathanclaire/rum';

EdgeRum.init({
  captures: [vitals(), interactions()],
  traceHostAllowlist: ['api.example.com'],
  release: 'web-2026.11.06',
});
```

With Angular, pass the same object to `provideEdgeRum({ … })`.

| Option | Type | Default | |
|---|---|---|---|
| `apiKey`, `endpoint` | string | from `capacitor.config.ts` | Override for this launch only (not stored). Use when the key comes from your own config service |
| `captures` | `Capture[]` | `init()`: none · `provideEdgeRum()`: `defaultCaptures()` from `@nathanclaire/rum-capacitor` | Optional captures. Replaces the whole default set — spread `...defaultCaptures()` to add to it |
| `traceHostAllowlist` | `string[]` | `[]` | Hosts that receive a `traceparent` header. Empty = no header anywhere |
| `ignoreUrls` | `(string \| RegExp)[]` | `[]` | Requests to leave out entirely |
| `sanitizeUrl` | `(url: string) => string` | — | Last step of URL reduction ([privacy](./privacy.md#urls-httpurl)) |
| `beforeSend` | `(event) => event \| null` | — | Edit or drop rows ([privacy](./privacy.md#beforesend)) |
| `release` | string | — | Your JS bundle version, stamped on JS errors. No default ([OTA recipe](#release-and-ota-updates)) |
| `debug` | boolean | `false` | `[edge-rum]` warnings in the console |

`init()` never throws. A missing or malformed key gives a debug warning only. A second `init()` is
ignored.

Errors and requests are always captured. Everything else is a capture:

| Capture | Package | In `defaultCaptures()` | Sends |
|---|---|---|---|
| `vitals()` | `@nathanclaire/rum` | yes | LCP, INP, CLS, FCP, TTFB |
| `interactions()` | `@nathanclaire/rum` | yes | `ui.interaction` (taps, rage and dead taps) |
| `frames({ slowThresholdMs = 34 })` | `@nathanclaire/rum` | yes | `frame.summary` |
| `longTasks()` | `@nathanclaire/rum` | yes | `long_task` |
| `consoleErrors()` | `@nathanclaire/rum` | yes | `console.error` lines as error breadcrumbs |
| `bridge()` | `@nathanclaire/rum-capacitor` | yes (the `-capacitor` set) | `bridge.summary` |
| `resourceTiming()` | `@nathanclaire/rum` | no | `resource_timing` |
| `ionicUi()` | `@nathanclaire/rum-angular` | no | `ui.interaction` for overlays, tabs, back, keyboard |

`@nathanclaire/rum`'s `defaultCaptures()` is the same set without `bridge()`. `provideEdgeRum()`
also wires Angular Router, Ionic page lifecycle and `ErrorHandler` capture; those aren't in
`captures`.

## Trace headers

Requests to a host in `traceHostAllowlist` get a W3C `traceparent` header linking them to the user
action that caused them.

- Entries are hostnames: `api.example.com` (that host only) or `.example.com` (any subdomain, not
  `example.com` itself). No scheme, port, path, wildcard or RegExp.
- The server must allow the header for cross-origin calls:
  `Access-Control-Allow-Headers: traceparent`. Without it the browser blocks the request.
- A `traceparent` your app sets itself is kept as is.
- `mode: 'no-cors'` requests never get the header.
- A redirect to a host outside the list keeps the header.

## `release` and OTA updates

`release` identifies the JS bundle an error came from. It has no default, because with live
updates the JS bundle and the app binary have different versions. Set it at build time from your
bundle version.

Write the version into a file before `ng build`, and pass it to `init()`:

```sh
# scripts/write-release.sh — run before `ng build`
echo "export const release = '${RELEASE:?set RELEASE}';" > src/environments/release.ts
```

```ts
import { release } from '../environments/release';
provideEdgeRum({ release });
```

- **Capgo:** use the version you upload, so errors match the bundle users run:
  `RELEASE=1.4.2 sh scripts/write-release.sh && ng build && npx @capgo/cli bundle upload --bundle 1.4.2`.
- **Appflow:** set `RELEASE` to the version you deploy as the live update, in a `prebuild` script.

Without `release`, errors still carry `app.bundle_id` (the live-update bundle id, or `builtin`), plus
the binary's `app.version` and `app.build_number`.

## Debugging

| Symptom | Check |
|---|---|
| Nothing arrives | `npx cap sync` was run; `apiKey` and `endpoint` are in `plugins.EdgeRum`; you're on a device or emulator, not the browser. Turn on `debug: true` |
| Data arrives late | Data is sent every 30 s, at 50 rows, or when the app goes to the background. Background the app to send now |
| No `traceparent` | Host is in `traceHostAllowlist` exactly; `traceparent.outcome` on `http.request` says why |
| CORS error after adding a host | Add `traceparent` to `Access-Control-Allow-Headers` on that server |
| Rows missing | Look at `sdk.health` `events_dropped.*`: `cap.*` = per-session limit, `before_send_*` = your `beforeSend`, `rejected` = the server refused the key |

Android logs under the `EdgeRum` tag (`adb logcat -s EdgeRum`).

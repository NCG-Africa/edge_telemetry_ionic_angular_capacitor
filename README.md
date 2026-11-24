# edge-rum

[![npm @nathanclaire/rum](https://img.shields.io/npm/v/@nathanclaire/rum.svg?label=%40nathanclaire%2Frum)](https://www.npmjs.com/package/@nathanclaire/rum)
[![npm @nathanclaire/rum-capacitor](https://img.shields.io/npm/v/@nathanclaire/rum-capacitor.svg?label=%40nathanclaire%2Frum-capacitor)](https://www.npmjs.com/package/@nathanclaire/rum-capacitor)
[![npm @nathanclaire/rum-angular](https://img.shields.io/npm/v/@nathanclaire/rum-angular.svg?label=%40nathanclaire%2Frum-angular)](https://www.npmjs.com/package/@nathanclaire/rum-angular)
[![Capacitor](https://img.shields.io/badge/Capacitor-5%2B-119EFF.svg?logo=capacitor)](https://capacitorjs.com/)
[![Angular](https://img.shields.io/badge/Angular-16%2B-DD0031.svg?logo=angular)](https://angular.dev/)

Real User Monitoring for **Ionic Angular Capacitor** apps on Android and iOS. Add it once and it
reports what your users actually experience — crashes, slow launches, failing requests, dead taps,
janky screens, slow native plugin calls — to Edge RUM.

```ts
// capacitor.config.ts
plugins: {
  EdgeRum: {
    apiKey: 'edge_xxx',
    endpoint: 'https://edgetelemetry.ncgafrica.com/collector/telemetry',
  },
},
```

```ts
// main.ts
bootstrapApplication(AppComponent, {
  providers: [provideRouter(routes), provideEdgeRum()],
});
```

That's the whole setup. Native crashes, ANRs, hangs, launch time, sessions, requests, screens, Web
Vitals and taps all start on their own.

**Version 5.0** · wire contract 4.3.0 · event catalogue 4.7 · upgrading from 4.x: read the
[migration guide](./docs/migration-5.md) first.

## Packages

| Package | |
|---|---|
| [`@nathanclaire/rum`](./packages/core) | Core: the `EdgeRum` API and the WebView captures |
| [`@nathanclaire/rum-capacitor`](./packages/capacitor) | **Required.** The native plugin `EdgeRum`: identity, sessions, native crashes, storage and sending |
| [`@nathanclaire/rum-angular`](./packages/angular) | `provideEdgeRum()`: Router, Ionic page and `ErrorHandler` capture |

All three always share one version. Install the same version of each.

## Requirements

| | Minimum |
|---|---|
| Capacitor | 5 (Swift Package Manager installs need Capacitor 8) |
| Android | 7.0 (API 24) |
| iOS | 14 (15 with Swift Package Manager) |
| Angular | 16, for `@nathanclaire/rum-angular` |
| Web | Not supported: in a browser every method is a silent no-op |

> ⚠ **The Edge RUM backend release for 5.0 must be live before you ship a build with this SDK.**
> 5.0 sends `sdk.name=ionic` on catalogue 4.7 names; an older backend rejects the data and it is lost.

---

## Contents

**Getting started**
- [Install](#install)
- [Quick start](#quick-start)
- [Verify it's working](#verify-its-working)
- [Configuration](#configuration)

**How-to guides**
- [Send a custom event or a number](#send-a-custom-event-or-a-number)
- [Time a journey](#time-a-journey)
- [Identify the signed-in user](#identify-the-signed-in-user)
- [Track screens](#track-screens)
- [Measure launch time](#measure-launch-time)
- [Track taps](#track-taps)
- [Report handled errors](#report-handled-errors)
- [Tag errors with your JS bundle version](#tag-errors-with-your-js-bundle-version)
- [Strip PII before it leaves the device](#strip-pii-before-it-leaves-the-device)
- [Sample a percentage of sessions](#sample-a-percentage-of-sessions)
- [Respect a user's opt-out](#respect-a-users-opt-out)
- [Connect your traces to your backend](#connect-your-traces-to-your-backend)

**Reference**
- [What the SDK captures](#what-the-sdk-captures)
- [API](#api)
- [Identity and sessions](#identity-and-sessions)
- [Delivery and reliability](#delivery-and-reliability)

**Help**
- [Troubleshooting](#troubleshooting)
- [Upgrading](#upgrading)
- [Contributing](#contributing)

---

## Install

```sh
npm install @nathanclaire/rum @nathanclaire/rum-capacitor @nathanclaire/rum-angular
npx cap sync
```

Leave out `@nathanclaire/rum-angular` if your app doesn't use Angular. `@nathanclaire/rum-capacitor`
is required: the native plugin is what stores and sends everything. Nothing is sent from JavaScript.

| Peer | Needed by | |
|---|---|---|
| `@capacitor/core` ≥ 5 | `-capacitor` | Already in your app |
| `@capacitor/app` ≥ 5 | `-capacitor` | Optional |
| `@angular/core`, `@angular/common`, `@angular/router` ≥ 16, `rxjs` ≥ 7 | `-angular` | Already in your app |

Run `npx cap sync` again after every change to `capacitor.config.ts`.

---

## Quick start

**1. Configure the plugin** in `capacitor.config.ts`:

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.example.app',
  appName: 'Example',
  webDir: 'www',
  plugins: {
    EdgeRum: {
      apiKey: 'edge_xxx',                                                  // your project key
      endpoint: 'https://edgetelemetry.ncgafrica.com/collector/telemetry', // ingest URL
    },
  },
};
export default config;
```

The native side starts when the app launches, before any JavaScript runs: native crashes,
`app.start`, sessions, lifecycle, memory and network changes are captured even if the WebView never
loads.

**2. Start the WebView side.**

Angular (standalone):

```ts
import { provideEdgeRum } from '@nathanclaire/rum-angular';

bootstrapApplication(AppComponent, {
  providers: [provideRouter(routes), provideEdgeRum({ traceHostAllowlist: ['api.example.com'] })],
});
```

Angular (NgModule):

```ts
import { EdgeRumModule } from '@nathanclaire/rum-angular';

@NgModule({ imports: [EdgeRumModule.forRoot({ traceHostAllowlist: ['api.example.com'] })] })
export class AppModule {}
```

Without Angular (Vue, React, plain JS):

```ts
import { EdgeRum } from '@nathanclaire/rum';
import { defaultCaptures } from '@nathanclaire/rum-capacitor';

EdgeRum.init({ captures: defaultCaptures() });
// name screens from your router (Vue Router shown):
router.afterEach((to) => EdgeRum.trackScreen(to.matched.at(-1)?.path ?? to.path));
```

`provideEdgeRum()` uses `defaultCaptures()` for you and also wires Angular Router, Ionic page
lifecycle and `ErrorHandler` capture. Your own `ErrorHandler` still runs, after ours.

> **Every method returns immediately and never throws.** It is safe to call any `EdgeRum` method
> before the plugin is ready — calls are queued. `init()` with a bad key logs a debug warning, it
> doesn't take your app down. The one async method is `getSessionId()`.

---

## Verify it's working

1. Turn on debug warnings: `provideEdgeRum({ debug: true })` (or `EdgeRum.init({ debug: true, … })`).
2. Run on a **device or emulator**, not `ionic serve` — the browser sends nothing.
3. Send one event and push the app to the background, which sends the data now instead of waiting
   for the 30-second timer:

```ts
EdgeRum.track('hello_world');
```

4. Watch the native log:
   - Android: `adb logcat -s EdgeRum`
   - iOS: the Xcode console, filtered on `EdgeRum`

You should see the upload accepted. If you don't, start at [Troubleshooting](#troubleshooting).

**The SDK is quiet by default.** With `debug` off it writes nothing to the WebView console. Turn it
on while integrating, then turn it off.

---

## Configuration

There are two places for settings, because some things must work before the WebView exists.

### `capacitor.config.ts` → `plugins.EdgeRum`

Read by the native plugin at launch.

| Key | Type | Default | What it does |
|---|---|---|---|
| `apiKey` | string | — | **Required.** Your project key (`edge_…`). Without it (or `endpoint`) data is kept on the device and sent once both are known |
| `endpoint` | string | — | **Required.** Ingest URL |
| `enabled` | boolean | `true` | `false` = capture nothing until [`EdgeRum.enable()`](#respect-a-users-opt-out). After `enable()` / `disable()` the stored choice wins |
| `sampleRate` | number 0–1 | `1.0` | [Share of sessions kept](#sample-a-percentage-of-sessions) |
| `hang` | boolean | `true` | Report main-thread hangs as `app.hang` |
| `hangTimeoutMs` | number | `2000` | Hang threshold |
| `anr` | boolean | `true` | Android only: report ANRs as `app.anr` |
| `anrTimeoutMs` | number | `5000` | ANR threshold |
| `memorySampling` | boolean | `false` | Periodic `memory.usage` events (session start / end and memory pressure are always on) |
| `memorySamplingIntervalMs` | number | `30000` | Interval; iOS rounds to whole seconds, minimum 1 s |

App name, package, version and build number are read from the app binary. They can't be set.

### `EdgeRum.init()` / `provideEdgeRum()` options

What the WebView captures. With Angular, pass the object to `provideEdgeRum({ … })`.

| Option | Type | Default | What it does |
|---|---|---|---|
| `apiKey`, `endpoint` | string | from `capacitor.config.ts` | Override for this launch only (not stored). Use when the key comes from your own config service |
| `captures` | `Capture[]` | `init()`: none · `provideEdgeRum()`: `defaultCaptures()` | Optional captures. **Replaces** the default set — spread `...defaultCaptures()` to add to it |
| `traceHostAllowlist` | `string[]` | `[]` | [Hosts that receive `traceparent`](#connect-your-traces-to-your-backend). Empty = no header anywhere |
| `ignoreUrls` | `(string \| RegExp)[]` | `[]` | Requests to leave out entirely (no row, no header). Your `endpoint` is always ignored |
| `sanitizeUrl` | `(url: string) => string` | — | Last step of [URL reduction](./docs/privacy.md#urls-httpurl) |
| `beforeSend` | `(event) => event \| null` | — | [Edit or drop rows](#strip-pii-before-it-leaves-the-device) |
| `release` | string | — | [Your JS bundle version](#tag-errors-with-your-js-bundle-version), stamped on JS errors |
| `debug` | boolean | `false` | `[edge-rum]` warnings in the console |

A second `init()` is ignored.

### Captures

Errors and requests are always captured. Everything else is a capture you import:

| Capture | Package | In `defaultCaptures()` | Sends |
|---|---|---|---|
| `vitals()` | `@nathanclaire/rum` | yes | `perf.lcp`, `perf.inp`, `perf.cls`, `perf.fcp`, `perf.ttfb` |
| `interactions()` | `@nathanclaire/rum` | yes | `ui.interaction` (taps, rage and dead taps) |
| `frames({ slowThresholdMs = 34 })` | `@nathanclaire/rum` | yes | `frame.summary` |
| `longTasks()` | `@nathanclaire/rum` | yes | `perf.long_task` |
| `consoleErrors()` | `@nathanclaire/rum` | yes | `console.error` lines as error breadcrumbs |
| `bridge()` | `@nathanclaire/rum-capacitor` | yes (the `-capacitor` set) | `bridge.summary` — timings of every Capacitor plugin call |
| `resourceTiming()` | `@nathanclaire/rum` | no | `perf.resource_timing` |
| `ionicUi()` | `@nathanclaire/rum-angular` | no | `ui.interaction` for overlays, tabs, back, keyboard |

```ts
import { defaultCaptures } from '@nathanclaire/rum-capacitor';
import { resourceTiming } from '@nathanclaire/rum';
import { provideEdgeRum, ionicUi } from '@nathanclaire/rum-angular';

provideEdgeRum({ captures: [...defaultCaptures(), resourceTiming(), ionicUi()] });
```

Use `defaultCaptures()` from `@nathanclaire/rum-capacitor`, not from `@nathanclaire/rum`: the core
one is the same set without `bridge()`.

Full reference: [docs/config-reference.md](./docs/config-reference.md).

---

## Send a custom event or a number

```ts
EdgeRum.track('checkout.coupon_applied', { coupon: 'SPRING', cart_value: 42 });
EdgeRum.measure('cart.items', 3);

const t = EdgeRum.time('search');
// …
t.end({ results: 12 });
```

- `track()` sends `custom.event` with your name in `event.name`. Query custom events by
  `event.name`.
- `measure()` and `time().end()` send a `custom.metric` reading with your name in `metric.name`.
- Attribute values are `string | number | boolean`.

---

## Time a journey

```ts
EdgeRum.startTask('checkout', { cart_value: 42 });
// …later, from any screen
EdgeRum.completeTask('checkout');
// or
EdgeRum.failTask('checkout', 'card_declined');
```

Each task sends **one** `task.complete` row when it ends: `task.name`, `task.outcome`
(`completed` | `failed` | `abandoned`), `span.duration_ms` and, for failures, `task.failure_reason`.
A task still open when the session ends is sent as `abandoned`.

---

## Identify the signed-in user

```ts
EdgeRum.identify({ id: 'u_42', name: 'Ada Lovelace', email: 'ada@example.com', phone: '+254700000000' });

// on sign-out
EdgeRum.clearUser();
```

- `user.id` goes on every row after `identify()`.
- `name`, `email` and `phone` are sent **once**, on a `user.profile.update` row, not on every row.
- In Angular, inject `EdgeRumService` — it has every `EdgeRum` method:

```ts
constructor(private rum: EdgeRumService) {}
onLogin(u: User) { this.rum.identify({ id: u.id, name: u.name }); }
```

---

## Track screens

**With Angular Router** there is nothing to do. `provideEdgeRum()` sends:

- `navigation` for every route change, named by the **route template** (`/products/:id`, never the
  raw URL), with `navigation.method` = `initial` | `push` | `pop` | `replace` and the time spent in
  guards, resolvers and lazy chunk loading (`navigation.{guards_ms,resolvers_ms,chunk_load_ms}`).
  A cancelled navigation sends nothing.
- `screen.duration` for each Ionic page, from `ionViewDidEnter` to `ionViewDidLeave`.

**Without Angular**, name screens yourself from your router:

```ts
EdgeRum.trackScreen('/settings');
```

Each screen name is also stamped as `screen.name` on errors, vitals, frames and plugin timings that
happen on it.

---

## Measure launch time

Every cold launch sends one `app.start`. `app.start.duration_ms` runs from process start to the
native bridge being ready, with the phases in between
(`app.start.{webview_created_ms,response_end_ms,dom_content_loaded_ms,load_ms,bridge_ready_ms}`).

To also measure when your first screen is **usable** — data loaded, spinner gone — call:

```ts
EdgeRum.markReady();
```

This adds `app.start.mark_ready_ms` to that launch's `app.start`. It must run within 30 s of the
bridge being ready, and it does not lengthen `duration_ms`.

---

## Track taps

`interactions()` (in `defaultCaptures()`) sends a `ui.interaction` for every tap, flagging
`ui.rage` (repeated fast taps) and `ui.dead` (a tap that did nothing).

The tapped element is named from, in order: `data-edge-action`, `aria-label`, `id`, its visible
text. `ui.name_source` says which was used. Give the taps you care about a stable name:

```html
<ion-button data-edge-action="checkout.pay">Pay now</ion-button>
```

Text is never read from editable fields. Add `data-edge-private` to an element (or any ancestor) to
keep its text out.

`ionicUi()` (opt-in, from `-angular`) also sends `ui.interaction` for overlay open / dismiss, tab
changes, back and the keyboard, named by the component tag only (`ion-modal`).

---

## Report handled errors

```ts
try {
  await pay();
} catch (err) {
  EdgeRum.captureError(err, { order_id: 'o_1' });
}
```

Two event names, and the difference matters for dashboards:

| Event | When | `error.cause` |
|---|---|---|
| `app.crash` | **Unhandled**: uncaught JS errors and promise rejections, native crashes (signal, NDK, `NSException`, JVM), a killed WebView | `unhandled_exception`, `promise_rejection`, `native_crash`, `webview_terminated` |
| `app.error` | **Caught by your app**: `captureError()`, Angular `ErrorHandler`, router errors | `handled`, `navigation_error` |

Both carry `error.type`, `error.message`, `error.stacktrace`, `error.breadcrumbs` and
`screen.name`. Native crashes are sent on the next launch. ANRs (Android) and hangs arrive as their
own events, `app.anr` and `app.hang`.

With `consoleErrors()` (in `defaultCaptures()`), `console.error` lines become breadcrumbs on the
next error.

Error messages and stacks are sent as thrown. Don't put personal data in them, or remove it in
[`beforeSend`](#strip-pii-before-it-leaves-the-device).

---

## Tag errors with your JS bundle version

With live updates (Capgo, Appflow), the JS bundle and the app binary have different versions, so
`release` has no default. Set it at build time:

```sh
# scripts/write-release.sh — run before `ng build`
echo "export const release = '${RELEASE:?set RELEASE}';" > src/environments/release.ts
```

```ts
import { release } from '../environments/release';
provideEdgeRum({ release });
```

- **Capgo:** use the version you upload:
  `RELEASE=1.4.2 sh scripts/write-release.sh && ng build && npx @capgo/cli bundle upload --bundle 1.4.2`.
- **Appflow:** set `RELEASE` to the live-update version in a `prebuild` script.

Without `release`, errors still carry `app.bundle_id` (the live-update bundle id, or `builtin`),
`app.version` and `app.build_number`.

---

## Strip PII before it leaves the device

```ts
provideEdgeRum({
  beforeSend: (event) => {
    if (event.type === 'event' && event.attributes['event.name'] === 'debug') return null; // drop
    delete event.attributes['user_note'];                                                  // edit
    return event;
  },
});
```

- Runs on every row captured in the WebView. Return the row to keep it, `null` to drop it.
  Throwing or returning anything else also drops it. Drops are counted in `sdk.health`.
- `eventName`, `metricName`, `type`, `timestamp`, session, trace and identity keys can't be changed.
- Rows captured natively (sessions, native crashes, `app.start`, lifecycle, memory, network) never
  pass through it.

What is **never** collected, whatever you configure: request and response headers and bodies,
query strings and fragments, native plugin call options and results, route params, form values and
key presses. Request URLs are reduced before they are stored —
`https://api.example.com/v2/users/8812/orders?token=x` becomes `api.example.com/v2/users/{id}/orders`.
Add your own rule with `sanitizeUrl`. Full details: [docs/privacy.md](./docs/privacy.md).

---

## Sample a percentage of sessions

```ts
// capacitor.config.ts
plugins: { EdgeRum: { apiKey, endpoint, sampleRate: 0.25 } },
```

The decision is made once per session, and a session is kept or dropped **as a whole** — you never
get half a session. Crashes, ANRs, `app.exit`, `app.start`, session bookends and `sdk.health` are
kept in every session regardless.

---

## Respect a user's opt-out

| You want | Do |
|---|---|
| Nothing captured until the user agrees | `enabled: false` in `plugins.EdgeRum`, then `EdgeRum.enable()` after consent |
| Stop capture | `EdgeRum.disable()` — deletes everything not yet sent |
| Forget the user and device | `EdgeRum.reset()` — deletes unsent data and the user, starts a new `device_id` and session |

`enable()` / `disable()` are remembered across launches and win over `enabled` in config.

---

## Connect your traces to your backend

```ts
provideEdgeRum({ traceHostAllowlist: ['api.example.com', '.internal.example.com'] });
```

Requests to those hosts get a W3C `traceparent` header linking the request to the tap, navigation
or launch that caused it. Your backend can join its spans to the user's action.

- Entries are hostnames: `api.example.com` (that host only) or `.example.com` (any subdomain, not
  `example.com` itself). No scheme, port, path, wildcard or RegExp.
- **CORS:** the server must allow the header —
  `Access-Control-Allow-Headers: traceparent`. Without it the WebView blocks the request.
- A `traceparent` your app sets itself is kept as is. `mode: 'no-cors'` requests never get one.

Every `http.request` says what happened in `traceparent.outcome`: `injected_attributed`,
`injected_unattributed`, `injected_expired`, `adopted`, `skipped_off_allowlist`,
`skipped_no_cors`, `skipped_no_session`.

Native crashes, hangs and ANRs carry the trace id of the last user action, so you can see what the
user had just done.

---

## What the SDK captures

| Area | Events |
|---|---|
| Sessions and app state | `session.started`, `session.finalized`, `app.lifecycle`, `app.start`, `network.change`, `memory.usage`, `memory.pressure`, `user.profile.update`, `sdk.health` |
| Errors and crashes | `app.crash`, `app.error`, `app.anr` (Android), `app.hang`, `app.exit` (Android 11+) |
| Screens and requests | `navigation`, `screen.duration`, `http.request` (`fetch` and `XMLHttpRequest`, so Angular `HttpClient` too), `ui.interaction` |
| Performance | `perf.lcp`, `perf.inp`, `perf.cls`, `perf.fcp`, `perf.ttfb`, `perf.long_task`, `frame.summary`, `bridge.summary`, `perf.resource_timing` |
| Your own | `custom.event`, `custom.metric`, `task.complete` |

Every row also carries `session.id`, `user.id` (after `identify`), device context (`device.*`,
`webview.version`), `app.bundle_id` and `network.type`.

Every attribute of every event: [docs/events.md](./docs/events.md).

### Per-session limits

Over a limit, rows are dropped and counted in `sdk.health` as `events_dropped.cap.*`.

| Rows | Limit per session |
|---|---|
| `app.error` | 50, at most 5 with the same `error.type` and top frame |
| `ui.interaction` | 200 |
| `bridge.summary` | 50 |
| `custom.event`, `task.complete`, `perf.long_task` and your own readings | 500 combined |

Session bookends, `app.start`, every `app.crash`, `app.anr`, `app.exit` and `sdk.health` are never
limited.

---

## API

Import `EdgeRum` from `@nathanclaire/rum`, or inject `EdgeRumService` (same methods) in Angular.

| Method | |
|---|---|
| `init(options?)` | Start the WebView side. Not needed with `provideEdgeRum()` |
| `identify({ id, name, email, phone })` | Set the signed-in user |
| `clearUser()` | Remove the user |
| `track(name, attrs?)` | `custom.event` |
| `measure(name, value, attrs?)` | `custom.metric` reading |
| `time(name)` → `{ end(attrs?) }` | `custom.metric` reading of the elapsed ms |
| `startTask(name, attrs?)` / `completeTask(name)` / `failTask(name, reason?)` | `task.complete` |
| `trackScreen(name, attrs?)` | Name a screen (only without Angular Router) |
| `captureError(error, attrs?)` | `app.error` |
| `markReady()` | First screen usable: `app.start.mark_ready_ms` |
| `setAttribute(key, value)` / `removeAttribute(key)` | Add / remove an attribute on every WebView row |
| `enable()` / `disable()` | Consent switch, remembered across launches |
| `reset()` | Forget user and device, start a new session |
| `getSessionId()` | `Promise<string>` — the current session id |

### Exports

| Package | Exports |
|---|---|
| `@nathanclaire/rum` | `EdgeRum`; captures `vitals`, `interactions`, `frames`, `longTasks`, `resourceTiming`, `consoleErrors`, `defaultCaptures`; types `EdgeRumOptions`, `EdgeRumEvent`, `BeforeSend`, `Capture`, `UserTraits`, `RumTimer`, `EventAttributes`, `AttributeValue` |
| `@nathanclaire/rum-capacitor` | `bridge`, `defaultCaptures` (core's set plus `bridge()`) |
| `@nathanclaire/rum-angular` | `provideEdgeRum`, `EdgeRumModule`, `EdgeRumService`, `ionicUi`, types |

---

## Identity and sessions

- **`device_id`** is generated on first launch and stored on the device (Keychain on iOS,
  SharedPreferences on Android). It survives app restarts and updates; `reset()` replaces it.
- **Sessions** end after 30 minutes idle or 4 hours, whichever comes first. `session.finalized` says
  which in `session.reason`, with the session's duration, event count and visited screens.
- **`user.id`** is only sent after `identify()`.

---

## Delivery and reliability

The native plugin owns sending, so data survives a WebView reload or a crash.

- Rows are written to an on-device store as they happen.
- Data is sent every 30 s, at 50 rows, or when the app goes to the background — gzip-compressed.
- **Offline:** nothing is lost. Unsent data waits on the device and is sent once the network is back,
  exactly once.
- **Server errors (5xx):** the request is retried with backoff.
- **Rejected (4xx):** the data is dropped, not retried, and counted in `sdk.health` as `rejected`.
- Without `apiKey` / `endpoint` the data is kept on the device until both are known.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing arrives | `npx cap sync` was run after editing `capacitor.config.ts`; `apiKey` and `endpoint` are in `plugins.EdgeRum`; you're on a device or emulator, not the browser. Turn on `debug: true` and read `adb logcat -s EdgeRum` |
| Data arrives late | Expected: sent every 30 s, at 50 rows, or on background. Background the app to send now |
| Data arrives but dashboards are empty | The backend release for 5.0 is not live yet; 5.0 data is rejected by an older backend |
| No `traceparent` header | The host is in `traceHostAllowlist` exactly. `traceparent.outcome` on `http.request` says why |
| CORS error after adding a host | Add `traceparent` to `Access-Control-Allow-Headers` on that server |
| Rows missing | `sdk.health` `events_dropped.*`: `cap.*` = per-session limit, `before_send_*` = your `beforeSend`, `rejected` = the server refused the key |
| Screens named by URL, not template | You're calling `trackScreen()` yourself with the URL. With Angular Router, don't call it |
| Errors show up twice | You call `captureError()` inside your own `ErrorHandler` — `provideEdgeRum()` already reports those |

---

## Upgrading

### To 5.0

5.0 is a clean break from 4.x: the native plugin does the sending, launch settings move to
`capacitor.config.ts`, captures are imported functions, and event names follow the backend's
event catalogue. Update the backend first. Step by step: [docs/migration-5.md](./docs/migration-5.md).
What changed: [CHANGELOG.md](./CHANGELOG.md).

---

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

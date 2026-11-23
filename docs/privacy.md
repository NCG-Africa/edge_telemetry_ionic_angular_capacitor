# Privacy

What edge-rum 5.0 collects, what it never collects, and the controls you have.

## Never collected

- Request and response **headers and bodies**. Only method, templated URL, status, timing and
  `Content-Length` sizes.
- Query strings, fragments and `user:pass@` parts of URLs.
- Native plugin call **options, results and messages** (`bridge.summary` has plugin name, method,
  counts, durations and error codes only).
- Route **params and resolved data** (router phases have guard / resolver timings and the route
  template only).
- Form values and key presses.

## URLs (`http.url`)

Each request URL is reduced before it is stored:

1. Capacitor HTTP proxy URLs (`…/_capacitor_http_interceptor_?u=…`) are unwrapped to the real URL.
2. Scheme, query, fragment and userinfo are dropped; host and port are kept.
3. Path segments containing a digit, or 32+ characters long, become `{id}`. Version segments
   (lowercase `v1`, `v2`) are kept. Paths deeper than 6 segments end in `/…`.
   `https://api.example.com/v2/users/8812/orders?token=x` → `api.example.com/v2/users/{id}/orders`
4. Your `sanitizeUrl(url)` runs last, on the reduced URL. If it throws or returns a non-string, the
   reduced URL is kept.

`ignoreUrls` drops a request entirely (no row, no `traceparent`). It matches the full URL before
step 2, by substring or `RegExp`. Your `endpoint` is always ignored.

## Screen names

Screens are named by Angular **route templates** (`/products/:id`), never the raw URL. Without
Angular, you choose the name in `trackScreen(name)`.

## Taps (`ui.target`)

The tapped element is named from, in order: `data-edge-action`, `aria-label`, `id`, its visible
text, then nothing. `ui.name_source` says which one was used. Text is never read from editable
fields. Add `data-edge-private` to an element (or any ancestor) to keep its text out, or set
`data-edge-action` to a neutral name. `ionicUi()` names only the component tag (`ion-modal`).

## Errors

Error messages and stack traces are sent as thrown, unscrubbed. Don't put personal data in error
messages, or remove it in `beforeSend`. Breadcrumbs reuse the URL and tap rules above.

## `beforeSend`

```ts
EdgeRum.init({
  beforeSend: (event) => {
    if (event.type === 'event' && event.eventName === 'custom.event' && event.attributes['event.name'] === 'debug') return null;
    delete event.attributes['user_note'];
    return event;
  },
});
```

- Runs on every row captured in the WebView, including `bridge.summary` and router phases.
- Return the row (changed or not) to keep it, `null` to drop it. Throwing or returning anything
  else also drops it. Drops are counted in `sdk.health`.
- `eventName`, `metricName`, `type`, `timestamp`, session, trace and identity keys can't be changed.
- Rows captured natively (sessions, native crashes, `app.start`, lifecycle, memory, network,
  `user.profile.update`, `sdk.health`) never pass through it.

## Identity

- `device_id` is generated on first launch and stored on the device (Keychain on iOS,
  SharedPreferences on Android). `reset()` replaces it.
- `user.id` is only sent after `identify({ id })`. `name`, `email`, `phone` are sent once, on
  `user.profile.update`, not on every row. `clearUser()` removes them.

## Consent

| You want | Do |
|---|---|
| Nothing captured until the user agrees | `enabled: false` in `capacitor.config.ts`, then `EdgeRum.enable()` after consent |
| Stop capture | `EdgeRum.disable()` — deletes everything not yet sent; remembered across launches |
| Forget the user and device | `EdgeRum.reset()` — deletes unsent data, user, and starts a new `device_id` and session |

`enable()` / `disable()` persist and win over `enabled` in config on later launches.

## Web

In a browser (`ionic serve`, PWA builds) nothing is captured or sent. Every method is a no-op.

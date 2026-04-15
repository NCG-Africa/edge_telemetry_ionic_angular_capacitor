# Privacy and data

What edge-rum captures, what it never captures, and how to give your users control.

## What is captured by default

### App and device info

Attached to every event:

- `app.name`, `app.version`, `app.package`, `app.environment`
- `device.id` — an opaque, SHA-256 derived identifier. Never the raw OS device ID.
- `device.platform` — `ios`, `android`, or `web`
- `device.model`, `device.manufacturer`, `device.os`, `device.osVersion`
- `device.isVirtual`, `device.screenWidth`, `device.screenHeight`, `device.pixelRatio`
- `device.batteryLevel`, `device.batteryCharging`
- `network.type`, `network.effectiveType`, `network.downlinkMbps`

### Session info

- `session.id` — an opaque identifier that rotates after 30 minutes of inactivity.
- `session.startTime`, `session.sequence`
- `user.id` — present only if you call `EdgeRum.identify()`.

### Automatically captured events

- HTTP requests (URL, method, status code, duration, request/response size)
- Angular route changes (from-screen, to-screen, duration)
- Web performance data (page load, responsiveness, layout stability)
- Unhandled JavaScript errors and promise rejections (type, message, stack)
- Ionic page enter / leave timing
- App foreground / background transitions
- Network connectivity changes

## What is never captured

edge-rum does not capture any of the following:

- Screen contents, DOM snapshots, or screenshots
- Form field values
- Local storage, session storage, or cookie contents
- HTTP request or response bodies
- HTTP headers (including `Authorization`, `Cookie`, `Set-Cookie`)
- IP addresses
- Precise geolocation
- Anything from a URL matching an `ignoreUrls` entry

## URL sanitisation

Captured URLs are rewritten before being sent.

### Default sanitiser

Query parameters with any of these names are stripped:

```
token, email, phone, key, secret, password, auth
```

So `https://api.example.com/search?q=hats&token=abc123` becomes
`https://api.example.com/search?q=hats`.

### Custom sanitiser

Override with the `sanitizeUrl` option. The function receives every URL before it is
captured and returns the string to record.

```typescript
EdgeRum.init({
  apiKey: 'edge_...',
  sanitizeUrl: (url) => {
    return url
      .replace(/\/users\/\d+/, '/users/:id')
      .replace(/\/orders\/[a-f0-9-]+/, '/orders/:id');
  },
});
```

Returning a completely different string is fine — the sanitiser is your last line of
defence before a URL is recorded.

## User identification

When you call `EdgeRum.identify({ id: '...' })`, the ID you supply is attached as
`user.id` on every subsequent event.

### Do

- Pass an opaque, internal identifier — e.g. a UUID or hashed user ID.
- Keep the ID stable across sessions for the same user.

### Do not

- Pass email addresses, phone numbers, real names, or usernames.
- Pass any value your support team could use to look up personal details.

If you need to log an authenticated user out, call `EdgeRum.identify({ id: '' })` before
your logout flow, or call `EdgeRum.disable()` and then `EdgeRum.enable()` to start a new
anonymous session.

## Consent management

### Hold off until consent is granted

Do not call `EdgeRum.init()` until your consent banner has been accepted.

```typescript
if (consent.analytics) {
  EdgeRum.init({ apiKey: 'edge_...' });
}
```

### Withdraw consent at runtime

```typescript
EdgeRum.disable();
```

This stops all capture and clears any pending offline sends. Data that has already
reached your backend is not affected — use your backend's retention controls to delete
it.

### Re-enable

```typescript
EdgeRum.enable();
```

Capture resumes under a fresh session ID.

## Data retention

edge-rum itself holds a rolling buffer of up to `maxQueueSize` sends (default 200) in
device storage while offline. These are deleted as soon as they successfully reach your
backend, or when `EdgeRum.disable()` is called. How long data is kept once it reaches
your backend is a decision your backend operators control.

## GDPR and similar regimes

- `EdgeRum.disable()` stops capture and clears local state.
- `device.id` is derived via SHA-256, so reversing it to the original OS identifier is
  not feasible.
- No IP address, precise location, or contact information is captured by the SDK.
- Use `sanitizeUrl` to strip any customer identifier appearing in paths.
- Handle data subject deletion requests on your backend using `user.id` as the key.

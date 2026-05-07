# Configuration reference

Every option accepted by `EdgeRum.init()` and `EdgeRumModule.forRoot()`.

```typescript
interface EdgeRumConfig {
  apiKey: string;
  endpoint: string;
  appName?: string;
  appVersion?: string;
  appPackage?: string;
  environment?: 'production' | 'staging' | 'development';
  sampleRate?: number;
  ignoreUrls?: (string | RegExp)[];
  maxQueueSize?: number;
  flushIntervalMs?: number;
  batchSize?: number;
  sanitizeUrl?: (url: string) => string;
  debug?: boolean;
}
```

## Options

### `apiKey` (required)

- Type: `string`
- Must start with `edge_`

Authenticates every request to your backend. Sent as the `X-API-Key` header. Treat it as
a secret in production builds — do not commit it to source control. Use environment
variables or a build-time secret injector.

### `endpoint` (required)

- Type: `string`

Full URL your data is sent to. Must be provided during initialization.

### `appName`

- Type: `string`
- Default: `undefined`

Human-readable application name. Attached to every event as `app.name`.

### `appVersion`

- Type: `string`
- Default: `undefined`

The version of your app, e.g. `"2.1.0"`. Attached as `app.version`. Set this from your
build pipeline so you can correlate issues to a release.

### `appPackage`

- Type: `string`
- Default: `undefined`

Bundle / package identifier, e.g. `"com.yourco.app"`. Attached as `app.package`.

### `environment`

- Type: `'production' | 'staging' | 'development'`
- Default: `'production'`

Deployment context. Attached as `app.environment`.

### `sampleRate`

- Type: `number` (0.0 – 1.0)
- Default: `1.0`

Capture rate for non-error events. `0.5` captures roughly half. Errors are always
captured regardless of this setting.

### `ignoreUrls`

- Type: `(string | RegExp)[]`
- Default: `[]`

URLs matching any entry are excluded from HTTP capture. Strings match as substrings.

```typescript
ignoreUrls: [
  'https://example.com/health',
  /\.png$/,
  /googletagmanager/,
]
```

### `maxQueueSize`

- Type: `number`
- Default: `200`

Maximum number of pending sends buffered while the device is offline. When the cap is
reached, the oldest pending send is dropped first.

### `flushIntervalMs`

- Type: `number`
- Default: `5000`

How often (in milliseconds) buffered events are sent. Errors are always sent immediately
regardless of this value.

### `batchSize`

- Type: `number`
- Default: `30`

Maximum number of events included in a single send. Matches the Android SDK default so
you see consistent batch sizes across platforms.

### `sanitizeUrl`

- Type: `(url: string) => string`
- Default: strips `token`, `email`, `phone`, `key`, `secret`, `password`, `auth` query params

Rewrite every captured URL before it is sent. Use this to remove customer identifiers
from paths:

```typescript
sanitizeUrl: (url) => url.replace(/\/users\/\d+/, '/users/:id'),
```

### `debug`

- Type: `boolean`
- Default: `false`

Logs every outgoing send to `console.debug` and emits warnings when sends fail. The API
key is redacted to `edge_****` in logs. Never enable in production.

## Example — full configuration

```typescript
EdgeRum.init({
  apiKey: process.env.EDGE_RUM_API_KEY!,
  endpoint: 'https://rum.yourco.internal/collector/telemetry',
  appName: 'Acme Mobile',
  appVersion: '4.2.1',
  appPackage: 'com.acme.mobile',
  environment: 'production',
  sampleRate: 0.25,
  ignoreUrls: [/\/health$/, 'https://maps.googleapis.com'],
  maxQueueSize: 500,
  flushIntervalMs: 10_000,
  batchSize: 50,
  sanitizeUrl: (url) => url.replace(/\/users\/\d+/, '/users/:id'),
  debug: false,
});
```

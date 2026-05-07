# Backend Changes Required for edge-rum Web SDK

This document is for the **backend team**. It lists every change needed to the existing
pipeline (currently serving the Android SDK) to support the web SDK.

The web SDK sends data to the **same endpoint** in the **same envelope format** as the
Android SDK. Most of the pipeline requires zero changes. Only the items listed here need work.

---

## What does NOT need to change

- Endpoint URL: `POST /collector/telemetry` — identical
- Auth: `X-API-Key` header — identical
- Outer envelope: `{ timestamp, data: { type: "batch", events: [] } }` — identical
- Individual event shape: `{ type: "event", eventName, timestamp, attributes }` — identical
- Existing `eventName` values the Kafka processor already handles:
  - `screen_view` — used for Angular route changes
  - `network_request` — used for HTTP captures
  - `performance` — used for Web Vitals
  - `app.crash` — used for JS errors and native crashes
  - `custom_event` — used for EdgeRum.track()
  - `custom_metric` — used for EdgeRum.time()
  - `app_lifecycle` — used for foreground/background events

---

## Change 1 — New platform value in device.platform

**Priority: High — needed from day one**

The Android SDK sets `device.platform = "android"`. The web SDK sets:
- `"ios"` when running as a Capacitor app on iOS
- `"android"` when running as a Capacitor app on Android
- `"web"` when running in a browser (PWA or dev)

The value `"web"` is new.

**Backend actions:**
- [ ] Check Kafka processor for `device.platform` switch/if statements — add `"web"` case
- [ ] Check dashboard queries that group by `device.platform` — `"web"` will now appear
- [ ] Check storage schema that enumerates platform values — add `"web"`

---

## Change 2 — New sdk.version and sdk.platform fields on all events

**Priority: High — needed from day one**

The web SDK adds two new attributes to every event that the Android SDK does not send:

```json
"sdk.version": "1.0.0",
"sdk.platform": "ionic-angular-capacitor"
```

**Backend actions:**
- [ ] Confirm Kafka processor does not reject events with unknown attribute keys
- [ ] Add `sdk.version` and `sdk.platform` columns to events storage (or confirm your
  attributes column handles arbitrary keys automatically)
- [ ] Add `sdk.platform` as a filterable dimension in dashboards to separate Android native
  vs Ionic/Capacitor vs web traffic

---

## Change 3 — New session.sequence and session.startTime fields

**Priority: Medium — needed for data quality monitoring**

The web SDK adds two fields the Android SDK does not send:

```json
"session.sequence": 42,
"session.startTime": "2024-01-15T10:25:00.000Z"
```

`session.sequence` is a monotonic counter per session. Gaps indicate dropped payloads
(offline period, crash, etc.) and are a data quality signal.

**Backend actions:**
- [ ] Store `session.sequence` in events table
- [ ] Consider a background job or query that detects sequence gaps per `session.id`
- [ ] Store `session.startTime` — decide whether to deduplicate with existing session records

---

## Change 4 — Three new eventName values (web-only)

**Priority: Medium — can ship without these but Kafka processor must not crash on unknown values**

These three `eventName` values do not exist in the Android SDK. If the processor has an
allowlist of valid values, add these. If it fails on unknown values, add a passthrough handler.

### 4a — page_load

Web-only. Fires once when the Capacitor WebView finishes loading.

Attributes:
```
page.ttfb_ms                  number   Time to First Byte in ms
page.dom_content_loaded_ms    number   DOMContentLoaded in ms
page.load_duration_ms         number   Full page load duration in ms
page.resource_count           number   Number of sub-resources loaded
page.route                    string   Normalised route at load time e.g. "/home"
```

Store in a `page_loads` table or alongside `performance` events.

### 4b — screen_timing

Web-only. Fires on Ionic page enter and leave transitions.

Attributes:
```
screen.name         string   Ionic component name e.g. "ProductDetailScreen"
screen.event        string   "enter" or "leave"
screen.duration_ms  number   Transition duration in ms
```

Store in a `screen_timings` table or alongside `screen_view` events.

### 4c — network_change

Web-only. Fires when Capacitor detects a network connectivity change.

Attributes:
```
network.connected      boolean   Whether device is connected after the change
network.type           string    "wifi" | "cellular" | "none" | "unknown"
network.previous_type  string    "wifi" | "cellular" | "none" | "unknown"
```

Store in a `network_events` table for correlation with errors and performance data.

---

## Change 5 — app.crash attribute alignment and new runtime field

**Priority: High — affects the crash Kafka processor**

The web SDK sends `app.crash` events using the same v2.0.0 attribute names as the Android SDK.
Verify the crash Kafka processor accepts these fields from both platforms:

```
exception_type    string     e.g. "TypeError", "NativeCrash"
message           string     Error message
stacktrace        string     Stack trace
is_fatal          boolean    false for JS errors, true for native crashes
handled           boolean    false = uncaught, true = via captureError()
error_context     string     "screen:{ScreenName}"
cause             string     "UnhandledError" | "PromiseRejection" | "AngularError" | "NativeCrash"
runtime           string     "webview" | "native"  ← NEW field, web-only
```

`runtime` is new. `"webview"` = JS error, `"native"` = native Capacitor crash.

**Backend actions:**
- [ ] Confirm crash processor does not error on unknown attributes
- [ ] Add `runtime` to crash storage schema
- [ ] Note: JS stacks from `runtime: "webview"` are minified and unreadable without source
  maps. See Change 8 below for the source map symbolication pipeline.

---

## Change 6 — ID format includes _web suffix

**Priority: Low — informational only**

The web SDK generates IDs in the same format as the Android SDK:

```
device.id:   "device_{timestampMs}_{8hexchars}_{platform}"
session.id:  "session_{timestampMs}_{8hexchars}_{platform}"
user.id:     "user_{timestampMs}_{8hexchars}"
```

Platform suffix is now `_web`, `_ios`, or `_android`. If any backend query extracts
platform from the ID suffix, add `_web` handling.

**Backend actions:**
- [ ] Check if any query does string matching on ID suffixes — if so, add `_web` case
- [ ] No storage schema changes needed — IDs are stored as strings

---

## Change 7 — CORS configuration (BLOCKING)

**Priority: Critical — without this the web SDK cannot send data from browsers**

The Android SDK makes requests from native code — CORS does not apply. The web SDK runs
in a WebView and in browsers where CORS is enforced.

Add to the `/collector/telemetry` endpoint response headers:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-API-Key
```

Or restrict to known app origins:
```
Access-Control-Allow-Origin: capacitor://localhost, ionic://localhost, http://localhost
```

Also handle the OPTIONS preflight request — respond 200 with the CORS headers, no body.

Origins used by Capacitor/Ionic:
- `capacitor://localhost` — iOS Capacitor apps
- `ionic://localhost` — some Android Capacitor configurations
- `http://localhost` — development builds and browsers

**Backend actions:**
- [ ] Add CORS headers to `/collector/telemetry`
- [ ] Handle OPTIONS preflight (HTTP 200, CORS headers, empty body)
- [ ] Test from a browser: `fetch('https://<your-host>/collector/telemetry', { method: 'OPTIONS' })` should return 200

---

## Change 8 — Source map upload and symbolication pipeline (new requirement)

**Priority: Medium — needed for crash reports to be usable**

JS stacks from the web SDK are minified:
```
TypeError: Cannot read properties of undefined
  at e.<anonymous> (main.a3f9b2c.js:1:48291)
  at e.handleEvent (main.a3f9b2c.js:1:12847)
```

Without source maps these are useless. The Android SDK sends native stacks which are
already human-readable. This is a new requirement with no Android equivalent.

Recommended approach:
1. Add a source map upload endpoint: `POST /collector/sourcemaps`
   Accepts: `{ appVersion, platform: "ionic-angular-capacitor", files: [{ filename, content }] }`
2. When a `app.crash` event arrives with `"runtime": "webview"`, queue for symbolication
3. Symbolication worker resolves the stack against stored source maps, updates the record
4. Dashboards display the resolved stack

This is the same pattern used by Sentry, Datadog Browser SDK, and Firebase Crashlytics.

**Backend actions:**
- [ ] Design source map storage (keyed by `appVersion` + `platform`)
- [ ] Implement `POST /collector/sourcemaps` upload endpoint
- [ ] Implement async symbolication worker
- [ ] Update crash dashboards to show resolved stacks when available

---

## Summary — what blocks launch vs what can follow

| Change | Priority | Blocks launch? | Est. effort |
|---|---|---|---|
| 1 — Handle device.platform "web" | High | Yes | Small |
| 2 — Handle sdk.version + sdk.platform attrs | High | Yes | Small |
| 3 — session.sequence + session.startTime | Medium | No | Small |
| 4a — page_load eventName | Medium | No | Medium |
| 4b — screen_timing eventName | Medium | No | Small |
| 4c — network_change eventName | Medium | No | Small |
| 5 — app.crash runtime field | High | No (degrades gracefully) | Small |
| 6 — ID _web suffix | Low | No | Minimal |
| 7 — CORS headers | Critical | **Yes — SDK cannot send without this** | Small |
| 8 — Source map symbolication | Medium | No | Large |

**Minimum for day-one launch: Changes 1, 2, and 7.**

Everything else can ship in parallel with SDK development or post-launch.

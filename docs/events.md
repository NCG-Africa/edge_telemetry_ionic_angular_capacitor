# Events

Everything edge-rum 5.0 sends, by name. Each row is either an **event** (`eventName`) or a **numeric
reading** (`metricName` + `value`). Names and keys follow the backend's event catalogue
(`docs/catalogue/*.yaml` in the backend repo, at the version pinned in
[`catalogue.version`](../catalogue.version)); a recorded example of every row is in
[`test/golden`](../test/golden) and the native `golden` folders. What is never collected:
[privacy.md](./privacy.md).

**Source:** JS = captured in the WebView, passes through `beforeSend`. Native = captured by the
plugin, never seen by `beforeSend`.

Every row also gets `session.id`, `user.id` (after `identify`), the device context
(`device.platform`, `device.model`, `device.platform_version`, `device.locale`, `webview.version`, …),
`app.bundle_id` and `network.type`, stamped by the plugin when the row is stored.

## Sessions and app state

| Name | Source | Key attributes |
|---|---|---|
| `session.started` | Native | `session.start_time`, `session.is_first_session`, `session.total_sessions`, `session.sampled` (only when `sampleRate` < 1) |
| `session.finalized` | Native | `session.duration_ms`, `session.event_count`, `session.metric_count`, `session.screen_count`, `session.visited_screens` (first 50), `session.reason` = `timeout` (30 min idle) \| `max_duration` (4 h). Timestamped at the last activity |
| `app.lifecycle` | Native | `lifecycle.state` = `foregrounded` \| `backgrounded` |
| `app.start` | Native | One per process. `app.start.type`, `app.start.duration_ms` (process start to bridge ready), phases `app.start.{webview_created_ms,response_end_ms,dom_content_loaded_ms,load_ms,bridge_ready_ms,mark_ready_ms}`. `mark_ready_ms` only when `markReady()` runs within 30 s of the bridge being ready; it does not lengthen `duration_ms` |
| `network.change` | Native | `network.type`, `network.previous_type` (`wifi` \| `cellular` \| `ethernet` \| `other` \| `none`) |
| `memory.usage` | Native | `memory.usage_mb` (the app process: total PSS on Android, physical footprint on iOS), `memory.type` = `pss` \| `footprint` \| `rss`, `memory.resident_kb`, `memory.source` = `session_start` \| `session_end` \| `periodic` (periodic only with `memorySampling`) |
| `memory.pressure` | Native | `memory.pressure_level` = `moderate` \| `critical` (an iOS memory warning is `critical`), `memory.trim_level` (Android), `memory.usage_mb`, `memory.source` |
| `user.profile.update` | Native | `user.id`, `user.name`, `user.email`, `user.phone` — after `identify()` |
| `sdk.health` | Native | `events_dropped.<reason>` counts, `queue_depth`. Only when something was dropped |

## Errors and crashes

Unhandled failures are `app.crash`; errors the app caught are `app.error`. `error.cause` tells them
apart. Both carry `error.type`, `error.message`, `error.stacktrace`, `error.breadcrumbs` and
`screen.name`.

| Name | `error.cause` | Source | Notes |
|---|---|---|---|
| `app.crash` | `unhandled_exception`, `promise_rejection` | JS | Stack frames as `app:///…`, `error.source=webview`, `release` (when set) |
| `app.error` | `handled` | JS | `captureError()` and Angular's `ErrorHandler` |
| `app.error` | `navigation_error` | JS (Angular) | Router navigation failed |
| `app.crash` | `native_crash` (signal, NDK) or `unhandled_exception` (uncaught `NSException`, JVM exception) | Native | `error.thread`, `error.is_main_thread`; iOS adds `error.binary_images`. Sent on the next launch |
| `app.crash` | `webview_terminated` | Native | WebView content process died. `webview.reason`, `webview.detected_by` = `callback` (Android) \| `inference` (iOS) |

| Name | Source | Key attributes |
|---|---|---|
| `app.anr` | Native, Android | `anr.duration_ms` (≥ `anrTimeoutMs`), `error.cause=anr`, main-thread `error.stacktrace` |
| `app.hang` | Native | `hang.duration_ms` (≥ `hangTimeoutMs`), `error.cause=hang`, main-thread `error.stacktrace` |
| `app.exit` | Native, Android 11+ | `exit.reason`, `exit.importance` (the Android importance code, a number), `exit.description`, `exit.status`, `exit.pss_kb`, `exit.rss_kb`. Reported on the next launch |

Native crashes, hangs and ANRs also carry `trace.id`, `rum.action.id`, `trace.root_type` of the last
user action, plus `trace.root_expired=true` when that action had already ended.

## Screens and requests

| Name | Source | Key attributes |
|---|---|---|
| `navigation` | JS | `navigation.to_screen` (route template, e.g. `/products/:id`), `navigation.from_screen`, `navigation.method` = `initial` \| `push` \| `pop` \| `replace` (a cancelled navigation sends nothing), `navigation.route_type`, `navigation.has_arguments`; Angular adds `navigation.{guards_ms,resolvers_ms,chunk_load_ms}` |
| `screen.duration` | JS | `screen.name`, `screen.duration_ms`, `screen.exit_method`, `span.start_time` (when the screen was entered). From Ionic `ionViewDidEnter` / `ionViewDidLeave`, or `trackScreen()` |
| `http.request` | JS | `fetch` and `XMLHttpRequest` (so Angular `HttpClient` too). `http.url` (templated, see [privacy](./privacy.md)), `http.method`, `http.status_code` (0 = network failure), `http.duration_ms`, `http.success` (200–399), `http.request_size`, `http.response_size`, `trace.id`, `span.id`, `traceparent.outcome` |
| `ui.interaction` | JS | `interactions()`: `ui.type` = `tap`, `ui.target`, `ui.name_source`, `ui.screen`, `ui.rage`, `ui.dead`. `ionicUi()`: `ui.type` = `overlay_open` \| `overlay_dismiss` \| `tab_change` \| `back` \| `keyboard_show`, `ui.target` = component tag |

`traceparent.outcome`: `injected_attributed`, `injected_unattributed`, `injected_expired`, `adopted`
(the app set its own header), `skipped_off_allowlist`, `skipped_no_cors`, `skipped_no_session`
(request before the plugin was ready).

## Performance

| Name | Source | Key attributes |
|---|---|---|
| `perf.lcp`, `perf.inp`, `perf.cls`, `perf.fcp`, `perf.ttfb` (readings) | JS, `vitals()` | `metric.unit` = `ms` \| `score`, `metric.rating`, `screen.name` |
| `perf.long_task` (reading) | JS, `longTasks()` | value = ms, `screen.name` |
| `frame.summary` | JS, `frames()` | Every window that drew a frame. `frame.total_frames`, `frame.slow_frames`, `frame.frozen_frames` (≥ 700 ms), `frame.max_total_duration_ms`, `frame.slow_frame_rate`, `frame.window_duration_ms`, `frame.source=raf` |
| `bridge.summary` | JS, `bridge()` | Per plugin + method per screen: `bridge.service`, `bridge.action`, `bridge.count`, `bridge.error_count`, `bridge.p50_ms`, `bridge.p95_ms`, `bridge.max_ms`, `bridge.error_codes`. Never the call's options or results |
| `perf.resource_timing` (reading) | JS, `resourceTiming()` (off by default) | value = p95 ms; per screen and host: `resource.host`, `resource.initiator_type`, `resource.count`, `resource.p95_ms`, `resource.transfer_kb` |

## Your own events

| Call | Sends |
|---|---|
| `track(name, attrs)` | `custom.event` with `event.name` |
| `measure(name, value, attrs)`, `time(name).end(attrs)` | `custom.metric` reading with your name in `metric.name` |
| `startTask` / `completeTask` / `failTask` | `task.complete` with `task.name`, `task.outcome` = `completed` \| `failed` \| `abandoned`, `span.duration_ms`, `task.failure_reason`. Open tasks are `abandoned` when the session ends |

## Per-session limits

Over the limit, rows are dropped and counted in `sdk.health` (`events_dropped.cap.*`).

| Rows | Limit |
|---|---|
| `app.error` | 50, at most 5 with the same `error.type` and top frame |
| `ui.interaction` | 200 |
| `bridge.summary` | 50 |
| `custom.event`, `task.complete`, `perf.long_task` and your own readings | 500 combined |

Session bookends, `app.start`, every `app.crash`, `app.anr`, `app.exit` and `sdk.health`
are never limited and are kept in every session regardless of `sampleRate`.

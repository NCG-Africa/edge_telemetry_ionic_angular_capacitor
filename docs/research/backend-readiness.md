# Backend readiness for an Ionic client: collector, processor, analytics

Ticket #74 (wayfinder map #68). Research only. As of 2026-10-27.

Pins (HEAD read):
- Collector: `9c9b385`. This is the content of `origin/main` merge `b765895` (PR #8, "Envelope stripping and Kafka header stamping", merged 2026-10-11). The local `main` is stale at `addeccb`, which predates PR #8.
- Processor: `488c29a`. This is branch `feat/18-endpoint-templating` (PR #21, **open**), 2 commits ahead of `origin/main` `7daf97a`. The only `internal/` delta is URL templating (P:extract.go:291-321, `domain.TemplateURL`). Every other line cited below is identical on `origin/main`.
- Analytics: `8632809`. This is branch `feat/58-crashed-session-count`, 2 commits ahead of `origin/main` `b73d861`, with a geo rollup crashed-session count. That delta touches nothing cited here.
- Ionic: `351f8e2`.

Not verified: what is **deployed**. Every claim is about merged or branch code, not about production.

## Summary

Top findings, ranked by how much they matter for the 5.0 decisions:

1. **An Ionic contract-4 batch would be accepted as-is today, in code** (contract-4 fit).
   - The collector classifies on root `contract_version` major ≥ 4. It strips non-envelope root keys (it never returns 400 for them), requires root `device_id`, and stamps `contract_version`/`tenant_id`/`app_id`/`environment`/`api_key_id` Kafka headers (C:envelope.go:25-40,44-59,62-79; C:handler.go:106-142,172).
   - The processor's `normalizeV4` is a passthrough with **no `sdk.name` check** (P:normalize.go:113-132).
   - The only hard gate is App resolution:
     - A bound key's `app_id` header is trusted.
     - A legacy key needs a registered `(package_name, platform∈android|ios)` (P:service.go:263-288; P:repository.go:56-73).
   - Both halves are merged: collector PR #8 and processor PR #9 (`feat/8-normalize-contract-version`).
2. **No `sdk.name` enum exists anywhere in backend code, so nothing lacks `ionic`** (contract-4 fit).
   - Spec R2 lists `ionic` (W:spec.md:40,113).
   - The legacy alias maps `sdk.platform: "ionic-angular-capacitor"` to `ionic` (P:normalize.go:220-221), and there is an Ionic golden test (P:testdata/normalize/ionic.legacy.golden.json:8).
   - v4 passes the value through unchecked.
   - `sdk.name` and `sdk.version` are **not persisted**: there is no column (P:schema_check.go:15-28), and analytics has zero SDK references. SDK attribution is invisible downstream.
3. **Ionic lands in the mobile views, never in web-RUM** (telemetry catalogue).
   - `/web/*` reads a separate `rum.*` schema with uuid app ids. That schema is written by "the edge agent's browser snippet through the platform ingest service" (A:repo/web_rum.go:17-19), not by the processor.
   - The processor writes `public.rum_*`, which `/mobile/apps/:app_id/*` and `/apps/:app_id/traces` read (A:api/mobile.go:40-66; A:api/traces.go:42-48).
   - An Ionic app must be registered as `android` or `ios`. The API rejects anything else (A:api/apps.go:364-368).
4. **Crashes are written where no dashboard reads them** (backend change, all SDKs).
   - The processor routes `app.crash`/`app.anr`/`app.hang` to `rum_errors` (P:service.go:695-698; P:repository.go:370).
   - Analytics crash, crash-free, geo and session views read `rum_crash_events` (45 references, e.g. A:repo/crash_analytics.go:78-101). Its only `rum_errors` reference is a DELETE (A:repo/app.go:243).
   - This is a known open item: P:docs/follow-ups.md:59-80, and the analytics design says "ignore the near-empty `rum_errors`" (A:docs/superpowers/specs/2026-09-08-rum-analytics-go-rewrite-design.md:106-107).
   - Ionic's crash fields reach typed columns but are invisible.
5. **The trace model is ready on the backend, and Ionic sends none of it** (trace model).
   - Seven trace columns sit on `rum_telemetry_events` (P:0002_android_wire_contract.up.sql:6-12; P:extract.go:279-289).
   - `trace_id`/`span_id`/`parent_span_id` are also on `rum_http_requests` (P:repository.go:346-358).
   - Indexes: `rum_action_id` (P:0002:77-78) and a partial `trace_id` index (P:0006).
   - The view `rum_action_envelopes` groups by `rum_action_id` (P:0002:96-106).
   - The analytics trace waterfall reads exactly these columns plus server `traces.spans` (A:repo/trace.go:59,72,94,224-245).
   - **`traceparent.outcome` has no column.** The live `rum_http_requests.trace_injection` enum (6 values) exists (A:schema/edge_db_schema.sql:104-111,1038-1046), but the processor never writes it. The processor spec said it would (P:docs/specs/2026-08-27-android-wire-contract/3-trace-columns-view.md:53), and the code dropped it (P:schema_check.go:24). Doc and code disagree.
6. **Name and key misses make 4 Ionic signals land in the bag only** (telemetry catalogue). This verifies #69 C14/C15/C18/C22 and goes one step further.
   - `user.interaction` has no case; `ui.interaction` does (P:service.go:707), and its table is unread by analytics anyway.
   - Native hang and ANR ride `app.crash`, which routes to `rum_errors`. That is fine, but `anr.duration_ms` and `crash.thread` miss the undotted `anr_duration_ms`/`crash_thread` (P:extract.go:324-341).
   - `frame_render_time` keys are dotless (`frames_total`, `slow_frames`, …, X:core/src/instrumentation/frames.ts:101-109). The processor reads only `frame.*` (P:extract.go:199-238).
   - Memory keys `unit`/`memory_type`/`memory_source` miss `metric.unit`/`memory.type`/`memory.source` (P:extract.go:210-216).
7. **Two mobile views are wrong for Ionic even when keys match** (backend change).
   - The frames view counts **every** `rum_performance_metrics` row of the app as a frame, with no `metric_name` filter (A:repo/performance.go:422-439; A:repo/session_detail.go:338-353). Ionic LCP/FCP/CLS/INP/TTFB/long_task/resource_timing/memory_usage inflate `total_frames`.
   - The memory view reads only `rum_performance_events` with a pressure level (A:repo/performance.go:304-310). Ionic `memory_usage` metrics never appear.
8. **Session journey counters never land** (backend change or SDK).
   - `rum_sessions` is first-write-wins: `ON CONFLICT … DO UPDATE SET session_id = EXCLUDED.session_id` (P:repository.go:254-258).
   - Ionic sends `session.event_count`/`screen_count`/`visited_screens`/`metric_count` only on `session.finalized`. By then the row exists, so the columns stay 0/empty.
   - `session.finalized` itself is honoured: it sets `end_time`/`status='ended'` (P:repository.go:122-123).
9. **Legacy-key or web Ionic dead-letters the whole batch** (contract-4 fit, R16).
   - The legacy App lookup accepts only `android|ios`, and `device.platform: "web"` maps to `unknown` (P:normalize.go:226-233; P:repository.go:57-59), giving `<app-not-registered>`.
   - It does the same when `appPackage` is unset: `app.package_name` is optional in Ionic (X:core/src/internal/context.ts:27).
   - With a bound key, web Ionic is accepted and `rum_devices.platform='web'`.
10. **The CORS default is off** (send policy).
    - The collector enables CORS only when `CORS_ALLOWED_ORIGINS` is set (C:routes.go:19-27; C:config.go:87). The default is empty.
    - Ionic's native main path uses CapacitorHttp, which bypasses CORS (X:capacitor/src/bootstrap.ts:81).
    - These paths go through the WebView and need CORS for `capacitor://localhost` / `https://localhost`:
      - the iOS sync-XHR beacon (X:capacitor/src/LifecycleCapture.ts:316-330);
      - Android/web `sendBeacon`, which cannot set `X-API-Key` and so gets 401 (C:handler.go:93-97,192-200);
      - pure web.

**Blocks 5.0?** Nothing in backend code blocks an Ionic 5.0 contract-4 sender from being **accepted**. Three backend items block it from being **visible**:
- crash table split (finding 4);
- frames/memory view filters (finding 7);
- `traceparent.outcome` / `trace_injection` write (finding 5).

Each needs a backend ticket. One item needs an SDK-or-backend decision before the 5.0 catalogue is frozen: rename to the processor's names (`ui.interaction`, `app.anr`/`app.hang`, `frame.summary`, dotted `memory.*`) or ask for aliases.

## Citation legend

| Prefix | Path under `/Users/mktowett/Development/edge_rum/` |
|---|---|
| `C:` | `edge_telemetry_collector_go/` (`internal/telemetry/` unless a dir is given; `routes.go` = `cmd/server/routes.go`; `config.go` = `internal/config/config.go`) |
| `P:` | `edge_telemetry_processor_go/` (`internal/telemetry/` for `.go` files; `repository.go`/`schema_check.go` in `internal/db/`; `00NN_*.sql` in `internal/db/migrations/`) |
| `A:` | `EdgeTelemetryRUMAnalyticsGo/internal/` (`schema/` and `docs/` are repo-root) |
| `X:` | `edge_telemetry_ionic_angular_capacitor/packages/` |
| `W:` | `wayfinder/` |

Note: `C:` here is the **collector**, not Cordova as in `ionic-gap-inventory.md`.

## 1. Collector

### 1.1 Request handling, in order

| Step | Behaviour | Status on fail | Cite |
|---|---|---|---|
| Key map ready | `Retry-After: 5` | 503 `not_ready` | C:handler.go:84-91 |
| Auth | `X-API-Key` only; format `edge_<lookup>_<secret>` (≥3 `_` parts) | 401 `authentication_failed` + `WWW-Authenticate: ApiKey` | C:handler.go:93-97,192-200; C:internal/auth/apikey.go:32-40 |
| Body | JSON; `Content-Encoding: gzip` accepted and bomb-limited; **`Content-Type` never checked** | 400 `invalid_data` | C:handler.go:99-105,207-223 |
| Size | `MAX_REQUEST_BYTES` 1 MiB (middleware); payload 5 MiB; event 100 KiB; ≤1000 events; non-empty `events` | 400 per code | C:config.go:89-95; C:validator.go:36-58,61-73 |
| Classify | no root `contract_version` → legacy; string major ≥4 (digits only) → v4; else unsupported | — | C:envelope.go:25-40 |
| device_id | v4/unsupported: root only. Legacy: root, then per event `device.id` / `attributes["device.id"]` | 400 + hint | C:handler.go:107-124; C:deviceid.go:10-42 |
| Rate limit | by `device:<id>` | 429 + `Retry-After` | C:handler.go:125-137,248-264 |
| Strip | v4 only: drop root keys outside the 8-key set, audit-log | never 400 (R3) | C:envelope.go:62-79; C:handler.go:138-142 |
| Collector-owned | drop client `tenant_id`, `geo`; add IP geo if enabled; legacy gets `data.tenant_id` | — | C:handler.go:143-148,165-167 |
| `batch_size` | overwritten with the real count; mismatch audit-logged | — | C:handler.go:161-163,227-233 |
| Headers | `tenant_id, api_key_id, contract_version ("legacy" if absent), environment, app_id, app_mismatch` | — | C:envelope.go:44-59 |
| `app_mismatch` | v4 + bound key + envelope `app` (pkg/platform) ≠ key's App → header, still 200 | — | C:envelope.go:85-96 |
| Kafka fail | — | **500** (Ionic does not retry 500: #69 R12) | C:handler.go:173-177 |

Routes: `POST /telemetry` and the permanent alias `POST /collector/telemetry` (C:routes.go:44-46). CORS is opt-in (C:routes.go:19-27).

### 1.2 Ionic today (legacy 3.1 wire) vs a contract-4 Ionic

| Aspect | Ionic 4.0 today | Ionic 5.0 contract-4 |
|---|---|---|
| Class | legacy: `sdk.contract_version` is an event attribute, not root (X:core/src/internal/context.ts:81) | v4 |
| device_id | found via `attributes["device.id"]` | must be root (R9) |
| `location` root key | passed through; processor ignores it (no field, P:internal/domain/telemetry.go:54-75) | stripped + logged (R7) |
| Kafka `contract_version` | `legacy` | e.g. `4.0.0` |
| Accepted? | yes | yes |

### 1.3 Allowlists and enums

None in the collector. It has no knowledge of `sdk.name`, `device.platform` or `eventName`. The only platform comparison is `app_mismatch`, which is informational (C:envelope.go:85-96).

## 2. Processor

### 2.1 Batch path

| Stage | Rule | Ionic effect | Cite |
|---|---|---|---|
| Contract | header `legacy`/absent → legacy; major in `{4}` → v4; else whole batch DLQ `<unsupported-contract>` | legacy today | P:normalize.go:34-49; P:service.go:160-169 |
| v4 identity | envelope only; per-event copies ignored but kept in the bag; `sdk.name` unchecked | ionic passes | P:normalize.go:113-141 |
| Legacy identity | first event with `app.package_name`; `sdk.name` = alias(`sdk.platform`); `app.platform` = `device.platform` if android/ios else `unknown` | `ionic`; web → `unknown` | P:normalize.go:144-233 |
| Tenant / device | missing → whole batch DLQ | — | P:service.go:170-177 |
| App | `app_id` header trusted; else read-only lookup `(tenant, pkg, android|ios)`; miss → DLQ `<app-not-registered>` (replayable) | web or no `appPackage` + legacy key → DLQ | P:service.go:263-288; P:repository.go:56-73 |
| App version | upsert `rum_app_versions` from identity `version`/`build_number` | `app.version`/`app.build_number` land | P:service.go:319-339 |
| Per event | device, user, session (first-write-wins), `rum_telemetry_events` row with **all attributes as JSONB** + trace cols, then dispatch | nothing is dropped | P:service.go:615-720; P:repository.go:254-258,274-278 |
| Session span | recomputed from stored events; `session.finalized` sets `end_time`/`status`; SDK `session.start_time`/`duration_ms` not read | Ionic `session.finalized` honoured | P:repository.go:114-160 |

The claim in CLAUDE.md:205, "Backend silently drops anything else", is **wrong**. The default case keeps the `rum_telemetry_events` row and its bag (P:service.go:715-717). #69 says the same.

### 2.2 Dispatch, by name

| Name / type | Target | Cite |
|---|---|---|
| any `type:"metric"` | `rum_performance_metrics` (name, value, `metric.unit`, `frame.*`, `memory.type/source`) | P:service.go:675-680; P:extract.go:199-219 |
| `frame.summary`, `memory_pressure` | `rum_performance_events` | P:service.go:687-690,821-824 |
| `frame.summary` (also) | `processor_frame_summaries` | P:service.go:745-752; P:extract.go:225-238 |
| `http.request` | `rum_http_requests` | P:service.go:691-694 |
| `app.crash` / `app.anr` / `app.hang` | `rum_errors` (undotted keys) | P:service.go:695-698; P:extract.go:324-341 |
| `navigation` | `rum_navigations` | P:service.go:699-702 |
| `screen.duration` | `rum_screen_durations` | P:service.go:703-706 |
| `ui.interaction` | `rum_ui_interactions` | P:service.go:707-710 |
| `user.profile.update` | `rum_users` update | P:service.go:711-714 |
| anything else | bag only | P:service.go:715-717 |
| any event with `device.locale`/`timezone`/`screen_width_px`/… | `processor_device_context` | P:extract.go:241-253 |
| any event with `user.name`/`email` | `rum_users` passive sync | P:service.go:776-791 |

### 2.3 Trace storage

| Wire key | Column | Width | Cite |
|---|---|---|---|
| `trace.id` | `rum_telemetry_events.trace_id`, `rum_http_requests.trace_id` | 32 | P:0002:6; P:extract.go:281,297 |
| `span.id` | `…span_id` (both) | 16 | P:0002:7; P:extract.go:282,298 |
| `parent.span.id` | `…parent_span_id` (both) | 16 | P:0002:8; P:extract.go:283,299 |
| `rum.action.id` | `rum_telemetry_events.rum_action_id` (indexed) | 16 | P:0002:9,77-78 |
| `trace.root_type` | `rum_telemetry_events.trace_root_type` | 16 | P:0002:10 |
| `span.start_time` | `span_start_time` timestamptz | — | P:0002:11 |
| `span.duration_ms` | `span_duration_ms` double | — | P:0002:12 |
| `traceparent.outcome` | **none**, bag only. The live `rum_http_requests.trace_injection` enum + `trace_adopted` + `user_action_id` exist but are never written | — | A:schema/edge_db_schema.sql:104-111,1038-1046; P:repository.go:346-358 |

Indexes: GIN `jsonb_path_ops` on `attributes`, which serves containment only (P:0002:70-71). There is also a partial index on `trace_id` (P:0006). View: `rum_action_envelopes` (P:0002:96-106).

### 2.4 Doc ↔ code disagreements

| Doc says | Code does |
|---|---|
| Spec 3 puts a `traceparent_outcome` VARCHAR on `rum_http_requests` (P:docs/specs/2026-08-27-android-wire-contract/3-trace-columns-view.md:53, 2-child-tables.md:34) | no such column. The conformance plan removed it (P:docs/superpowers/specs/2026-08-30-…-design.md:20,86) |
| `performanceEventNames` comment: child tables "land in a later step" (P:service.go:815-820) | they already exist (P:service.go:691-714) |
| Ionic `payload-schema.json:367`: frame keys are "dotless to match the EdgeTelemetryProcessor's frame-bucketing API"; "the processor must accept either" shape | the processor reads only dotted `frame.*` and has no `frames_total` logic (P:extract.go:210-213,225-238) |
| Ionic CLAUDE.md:205: unknown names are dropped | kept in the bag (P:service.go:715-717) |

## 3. Analytics

### 3.1 Which surface sees Ionic

| Surface | Routes | Reads | Ionic? | Cite |
|---|---|---|---|---|
| Web RUM | `/web/summary`, `/web/apps/:id/{sessions,pages,vitals,actions,network,activity}`, `/web/errors`, `/web/sessions/:id/*` | `rum.apps` (uuid), `rum.sessions`, `rum.pageviews`, `rum.errors`, `rum.web_vitals`, `rum.user_actions`, `rum.network_requests`, `rum.events` | **no**: a different writer and schema; the processor never writes `rum.*` | A:api/web_rum.go:28-53; A:repo/web_rum.go:17-19 |
| Web traces | `/web/apps/:id/traces[/coverage]`, `/web/sessions/:id/traces` | `rum.network_requests` + `traces.spans` | no | A:api/traces.go:46-48; A:repo/trace_web.go:48,83 |
| Mobile | `/mobile/apps/:app_id/*` (int id from `public.rum_apps`) | `public.rum_*` | **yes**, as an `android` or `ios` App | A:api/mobile.go:40-66 |
| Mobile traces | `/apps/:app_id/traces[/coverage]`, `/traces/:trace_id`, `/sessions/:pk/traces` | `rum_http_requests` + `rum_telemetry_events` trace cols + `traces.spans` | yes, once Ionic sends trace keys | A:api/traces.go:42-45; A:repo/trace.go:59,72,94,224-245 |

Platform filters:
- App registration accepts only `android|ios` (A:api/apps.go:364-368). `unknown` is "legacy" (A:api/apps.go:302-303).
- Portfolio groups by `rum_devices.platform` (A:repo/app_portfolio.go:235-239). Native Ionic sends `ios`/`android` from `Device.getInfo` (X:capacitor/src/DeviceContext.ts:253); web sends `web` (:284).
- There is no SDK filter: zero references to `sdk`/`ionic`.

### 3.2 Mobile tables: written vs read

| Table | Processor writes | Analytics reads | Ionic feeds it |
|---|---|---|---|
| `rum_http_requests` | ✓ | ✓ (56 refs) | ✓ |
| `rum_screen_durations` | ✓ | ✓ screen flow, experience, session detail (A:repo/screen_flow.go:50; A:repo/experience.go:546) | ✓ |
| `rum_sessions` / `rum_users` / `rum_devices` | ✓ | ✓ | ✓ |
| `rum_telemetry_events` (trace cols) | ✓ | ✓ traces (A:repo/trace.go:72) | trace cols NULL |
| `rum_errors` | ✓ | ✗ delete only (A:repo/app.go:243) | ✓ (invisible) |
| `rum_crash_events` | ✗ | ✓ 45 refs (A:repo/crash_analytics.go:78-101) | ✗ |
| `rum_navigations` | ✓ | fallback only in `summary_refresh` (A:repo/summary_refresh.go:32-33,79) | ✓ |
| `rum_navigation_events` | ✗ | ✓ session detail (A:repo/session_detail.go:95,164,423) | ✗ |
| `rum_performance_metrics` | ✓ | frames view, **no `metric_name` filter** (A:repo/performance.go:422-439; A:repo/session_detail.go:338-353) | ✓ (pollutes frames) |
| `rum_performance_events` | ✓ (`frame.summary`/`memory_pressure`) | memory views (A:repo/performance.go:304-310; A:repo/session_detail.go:295-299) | ✗ |
| `rum_ui_interactions` | ✓ (`ui.interaction`) | ✗ delete only | ✗ |
| `processor_frame_summaries` | ✓ (`frame.summary`) | ✗ delete only | ✗ |
| `processor_device_context` | ✓ | ✗ 0 refs | ✗ (no matching keys) |

## 4. Key-landing matrix (Ionic `351f8e2`)

Method as in `edge_telemetry_react_native/docs/coverage-gap.md`. Every key is stored in `rum_telemetry_events.attributes` regardless of tier (P:service.go:657,662). The question is whether a column exists and whether a dashboard reads it.

Tiers:
- **col✓**: a typed column, and analytics reads the table.
- **col✗**: a typed column, and no dashboard reads it.
- **id**: consumed for identity, no column.
- **col∅**: a column exists but is never filled for Ionic.
- **bag**: JSONB only.
- **miss**: near-miss of a key the processor does read.

### 4.1 Event-name routing

| Ionic name | Kind | Lands in | Read by product | Processor name it would need |
|---|---|---|---|---|
| `navigation` | event | `rum_navigations` | fallback only | — |
| `screen.duration` | event | `rum_screen_durations` | ✓ | — |
| `http.request` | event | `rum_http_requests` | ✓ | — |
| `app.crash` (JS; native cause=NativeCrash) | event | `rum_errors` | ✗ (`rum_crash_events` is read) | — |
| `app.crash` cause=ANR / Hang | event | `rum_errors` | ✗ | `app.anr` / `app.hang` (same table; routing already works) |
| `user.interaction` | event | bag | ✗ | `ui.interaction` + `ui.*` keys (table unread anyway) |
| `user.profile.update` | event | `rum_users` update | ✓ | — |
| `session.started` | event | bag; excluded from activity span | — | — |
| `session.finalized` | event | bag; sets `end_time`/`status` | ✓ via `rum_sessions` | — |
| `custom_event`, `app_lifecycle`, `page_load`, `network_change` | event | bag | ✗ | none exist |
| `LCP` `FCP` `CLS` `INP` `TTFB` | metric | `rum_performance_metrics` | ✗; counted as frames | none; web-vital view is `rum.web_vitals` only |
| `long_task`, `resource_timing` | metric | `rum_performance_metrics` | ✗; counted as frames | — |
| `frame_render_time` | metric | `rum_performance_metrics` (frame cols NULL) | counted as 1 frame, unrated | `frame.summary` event + `frame.*` keys |
| `memory_usage` | metric | `rum_performance_metrics` (memory cols NULL) | ✗ | `memory_pressure` event + `memory.usage_mb`/`memory.pressure_level` |

### 4.2 Context keys (on every event, 33)

| Key | Tier | Lands | Cite |
|---|---|---|---|
| `app.version`, `app.build_number` | col✓ | `rum_app_versions` → `rum_sessions.app_version_id` | P:service.go:319-339 |
| `app.package_name` | id | App lookup (legacy key only) | P:normalize.go:157-176 |
| `app.name` | id | `Batch.AppName`, never written | P:normalize.go:177 |
| `app.environment` | bag | environment comes from the key header instead | P:normalize.go:76; P:service.go:643 |
| `device.id` | col✓ | `rum_devices.device_id` | P:service.go:630 |
| `device.platform` | col✓ | `rum_devices.platform` (raw, incl. `web`) | P:service.go:631 |
| `device.model`, `device.manufacturer`, `device.platform_version` | col✓ | `rum_devices.*` | P:extract.go:153-155 |
| `device.os`, `device.isVirtual`, `device.batteryLevel`, `device.batteryCharging` | bag | — | — |
| `device.screenWidth`, `device.screenHeight`, `device.pixelRatio` | miss | `processor_device_context` wants `device.screen_width_px`/`_height_px`/`screen_density` (unread anyway) | P:extract.go:241-253 |
| `network.type` | col✓ | `rum_sessions.network_type` (first event of session) | P:extract.go:195 |
| `network.connected`, `network.effectiveType`, `network.downlinkMbps` | bag | — | — |
| `session.id` | col✓ | `rum_sessions.session_id` | P:extract.go:188 |
| `session.is_first_session`, `session.total_sessions` | col✓ | `rum_sessions.*` (first write) | P:extract.go:193-194 |
| `session.start_time` | bag | ignored by design; recomputed | P:repository.go:117 |
| `session.sequence` | bag | — | — |
| `user.id` | col✓ | `rum_users.user_id` | P:extract.go:167 |
| `user.name`, `user.email`, `user.phone` | col✓ | `rum_users` passive sync | P:service.go:776-791 |
| `sdk.platform` | id | → `sdk.name="ionic"`, not stored | P:normalize.go:178,220 |
| `sdk.version` | id | identity only, not stored | P:normalize.go:178 |
| `sdk.contract_version` | bag | inert; the class comes from the collector header | C:envelope.go:25-29 |

Context tally: 15 col✓ · 4 id · 3 miss · 11 bag.

### 4.3 Event and metric keys

| Event | Key | Tier | Note / cite |
|---|---|---|---|
| navigation | `navigation.from_screen` `to_screen` `method` `route_type` `has_arguments` `timestamp` | col✗ (6) | `rum_navigations`, read only as `summary_refresh` fallback. P:extract.go:343-352 |
| screen.duration | `screen.name` `screen.duration_ms` `screen.exit_method` | col✓ (3) | P:extract.go:354-360 |
| screen.duration | `screen.timestamp` | bag | the event timestamp is used |
| http.request | `http.url` `http.method` `http.status_code` `http.duration_ms` `http.success` | col✓ (5) | P:extract.go:291-300. URL templating only in PR #21 |
| http.request | `http.timestamp` | bag | — |
| app.crash | `exception_type` `message` `stacktrace` `is_fatal` `handled` `error_context` `cause` | col✗ (7) | `rum_errors`, unread. P:extract.go:324-341 |
| app.crash | `runtime` | bag | — |
| app.crash | `crash.breadcrumbs`, `crash.breadcrumb_count` | bag | `rum_crash_events.breadcrumbs`/`breadcrumb_count` exist but the processor doesn't write that table (A:schema/edge_db_schema.sql:969-991) |
| app.crash (native) | `crash.thread` | miss | wants `crash_thread` |
| app.crash (native) | `anr.duration_ms` | miss | wants `anr_duration_ms` / `hang_duration_ms` |
| app.crash (native) | `crash.platform` `crash.id` `crash.captured_at` `crash.platform_version` `crash.signal` `crash.symbolication` | bag (6) | X:capacitor/src/NativeCrashCapture.ts:135-155 |
| user.interaction | `interaction.type` `screen` `timestamp` `target_tag` `target_id` `target_class` `target_role` | bag (7) | wants `ui.type`/`ui.target`/`ui.screen` under `ui.interaction` |
| user.profile.update | `user.profile_version`, `user.profile_updated_at` | bag | the processor bumps its own `profile_version` |
| custom_event | `event.name` | bag | — |
| app_lifecycle | `lifecycle.event`, `lifecycle.cold_start_ms` | bag | — |
| page_load | `page.ttfb_ms` `dom_content_loaded_ms` `load_duration_ms` `resource_count` `route` | bag (5) | — |
| network_change | `network.previous_type` | bag | — |
| session.started | `session.start_reason` | bag | — |
| session.finalized | `session.event_count` `metric_count` `screen_count` `visited_screens` | col∅ (4) | columns exist; first-write-wins means they stay 0/empty. P:repository.go:254-258 |
| session.finalized | `session.duration_ms` `ended_at` `end_reason` `journey_truncated` `sdk.error_count` `sdk.dropped_count` `sdk.disposed_captures` | bag (7) | duration is recomputed server-side |
| metric (all) | top-level `metricName`, `value` | col✗ | `rum_performance_metrics.metric_name`/`value` |
| vitals, long_task, resource_timing | `metric.unit` | col✗ | — |
| vitals | `metric.rating`, `metric.screen` | bag | — |
| long_task | `metric.name` | bag | — |
| resource_timing | `metric.resource_name` `metric.resource_type` `metric.transfer_size` | bag (3) | — |
| frame_render_time | `frames_total` `slow_frames` `dropped_frames` `p50_ms` `p95_ms` `worst_ms` `window_ms` | miss (7) | wants `frame.total_frames`/`frame.slow_frames`/`frame.max_total_duration_ms`/`frame.window_duration_ms` on `frame.summary` |
| memory_usage | `unit`, `memory_type`, `memory_source` | miss (3) | wants `metric.unit`/`memory.type`/`memory.source` |

Event/metric tally (distinct keys, excluding context):

| Tier | Count |
|---|---|
| col✓ | 8 |
| col✗ | 14 (6 nav + 7 crash + `metric.unit`) |
| col∅ | 4 |
| miss | 12 |
| bag | 41 |

Product-visible today: 23 of ~112 distinct keys (15 context + 8 event).

### 4.4 Trace keys

None sent today. All 7 columns in §2.3 stay NULL for Ionic. The wire is frozen in `edge_telemetry_android/docs/specs/backend-wire-contract.md`. The landing is ready: see `trace-v3-for-webview.md` (#70).

## 5. Open questions for backend team

1. **Deployed vs merged.** Are collector PR #8 and processor PR #9 live? If the collector is older than `b765895`, it sends no Kafka headers (local stale `main` `addeccb` publishes `nil` headers), so every batch is legacy in the processor and a contract-4 body would DLQ as `<app-not-registered>`.
2. **Crash table split** (P:docs/follow-ups.md:59-80). Should the processor write `rum_crash_events`, or should analytics read `rum_errors`? Ionic crashes are invisible until this is decided. The same question applies to `rum_navigations` vs `rum_navigation_events`.
3. **`traceparent.outcome`.** Will the processor map it to the live `rum_http_requests.trace_injection` enum? The 6 enum values must match the Android v3 outcome set, and the check constraints matter (A:schema/edge_db_schema.sql:1041-1046).
4. **Frames view.** Add `metric_name` filtering (e.g. `frame_render_time` only), or move Ionic to a `frame.summary` event? Either way, the windowed shape needs a reader: `processor_frame_summaries` is unread.
5. **Memory.** Should `memory_usage` metrics feed the memory view, or should SDKs send `memory_pressure` events?
6. **Aliases vs renames.** Will the backend alias `user.interaction`→`ui.interaction`, `anr.duration_ms`→`anr_duration_ms`, and `crash.thread`→`crash_thread`? Or should Ionic 5.0 rename? We recommend Ionic renames, to keep the backend single-spelling.
7. **Session counters.** Should `rum_sessions` take `event_count`/`screen_count`/`visited_screens` from `session.finalized` (last-write), or are these columns legacy?
8. **SDK attribution.** Should `sdk.name`/`sdk.version` get a column, for example on `rum_sessions` or `rum_app_versions`, so mixed-SDK apps can be split?
9. **CORS.** What is `CORS_ALLOWED_ORIGINS` in production? Ionic WebView beacons need `capacitor://localhost` and `https://localhost`. `sendBeacon` cannot carry `X-API-Key`. Should there be a key-in-query or other beacon path, or should Ionic drop `sendBeacon`?
10. **Web vitals on mobile.** Is there any plan to show WebView LCP/INP/CLS for hybrid apps on mobile views, given that `/web/*` reads only `rum.*`?

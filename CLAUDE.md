# CLAUDE.md — edge-rum SDK Development Guide

Read this before writing code. **`docs/spec.md` (edge-rum 5.0 build spec) is the source of truth**;
rules are cited by number ("spec A4"). Reasoning lives in `docs/decisions.md` (ADRs). Where this file
and the spec disagree, the spec wins — fix this file.

---

## What this project is

`edge-rum` is a Real User Monitoring SDK for **Ionic Angular Capacitor** apps, published as three
packages (spec K1): `@nathanclaire/rum` (core), `@nathanclaire/rum-capacitor` (required; the native
plugin is the only sink), `@nathanclaire/rum-angular`.

Data goes to the EdgeTelemetryProcessor on **wire contract 4.0.0**, shared with the Android, iOS,
Flutter, React Native and Cordova SDKs (`sdk.name = "ionic"`, spec W1).

### Who owns what (spec A1, ADR-034/036)

| Native plugin `EdgeRum` (Kotlin / Swift) | JS (core + -capacitor + -angular) |
|---|---|
| config (`capacitor.config.ts` → `plugins.EdgeRum`), app identity, `device_id`, session + rotation, sampling, caps, user store, consent, outbox, gzip sender, envelope | WebView capture (errors, fetch/XHR, router, Ionic lifecycle, taps, vitals, frames), `beforeSend`, global attributes, in-memory buffer |
| native capture: crash, ANR, hang, exit, WebView death, `app.start`, lifecycle, memory, network | hands events to native via `enqueue` (spec T1) |

There is **no JS transport, queue, session or ID generation** (spec K4). JS reaches the plugin through
the `Capacitor` global (ADR-046). On web the SDK is a silent no-op (spec A7).

---

## The rules that override everything else

### Rule 1 — Terminology firewall (spec N3, ADR-033)

Banned in the public surface: `packages/*/src/index.ts` exports, `.d.ts` output, consumer docs and
READMEs, errors or `console.*` output a consumer can see.

```
opentelemetry / otel / otlp / tracer
TracerProvider / SpanProcessor / SpanExporter / MeterProvider / LoggerProvider
telemetry / instrumentation / sampling / batch / flush / collector / pipeline
metric / metrics (in API names; "performance data" in docs)
```

`trace`, `span`, `tracing`, `traceparent` are **allowed**. One sanctioned exception: `EdgeRumEvent`
keeps the wire fields `type: 'metric'` / `metricName` (ADR-046 §6). Internal code may use any name.
Replacements and the literal wire values allowed in code spans: `docs/terminology.md`; enforced by
`pnpm terminology-check` and `test/docs-terminology.test.ts`.

### Rule 2 — JSON only; gzip on the wire, applied by the native sender (spec T2)

`Content-Type: application/json`, `Content-Encoding: gzip`, `X-API-Key` header. No other encoding.

### Rule 3 — No AI attribution in git or on GitHub

Never add `Co-Authored-By: Claude …`, `🤖 Generated with Claude Code`, or any other AI
co-author / "generated with" line to commits, PR titles or bodies, issues, comments or code. The
repo owner does not want Claude listed as a GitHub contributor. This overrides any tool template
or harness reminder that suggests a trailer.

---

## Event payloads

- Event names and keys: **spec §7 (E1–E34)**, baseline = Cordova catalogue name-for-name. Consumer
  catalogue: `docs/events.md`; wire shape: `docs/payload-schema.json` (tested against the native
  goldens). Never emit `page_load`, `user.interaction`, `frame_render_time`, `bridge.call`,
  `cordova.deviceready_timeout`.
- JS rows: `{ type: 'event', eventName, timestamp, attributes }`; numeric rows:
  `{ type: 'metric', metricName, value, timestamp, attributes }`.
- `timestamp` is ISO 8601 (`new Date().toISOString()`), never Unix ms.
- `attributes` are **flat primitives only** (`string | number | boolean`); flatten with dotted keys
  at the capture layer.
- Native stamps `session.id`, `user.id`, device context (`device.*`, `webview.version`),
  `app.bundle_id`, `network.type` at append. JS never sends those, nor `device.id`, `app.*`, `sdk.*`.
- Unknown event names are **not** dropped by the backend: they land in `rum_telemetry_events`.
  Still, adding a name or key needs the spec / an ADR first, checked with the backend team (spec §14).

### eventName table (spec §7)

| Source | Names |
|---|---|
| JS core | `app.crash` (JS errors, `captureError`), `http.request`, `navigation` (`trackScreen`), `screen.duration`, `custom_event`, `task.complete`, `ui.interaction`, `frame.summary`; numeric `LCP` `INP` `CLS` `FCP` `TTFB` `long_task` `resource_timing`, host `measure`/`time` names |
| `-capacitor` JS | `bridge.summary` |
| `-angular` | `navigation` (+ `navigation.{guards_ms,resolvers_ms,chunk_load_ms}`), `screen.duration`, `app.crash` (`ErrorHandler`, `cause=NavigationError`), `ui.interaction` (`ionicUi()`) |
| Native | `session.started`, `session.finalized`, `app_lifecycle`, `app.start`, `app.crash` (native, `WebViewTerminated`), `app.hang`, `app.anr` + `app.exit` (Android), `network_change`, `memory_pressure`, numeric `memory_usage`, `user.profile.update`, `sdk.health` |

### Envelope (native sender, spec W1, T1)

One sealed outbox segment = one `POST`, headers `Content-Type: application/json`,
`Content-Encoding: gzip`, `X-API-Key`. Top-level keys, in order: `type: "telemetry_batch"`,
`contract_version: "4.0.0"`, `timestamp` (per attempt), `batch_size`, `device_id`,
`sdk: { name: "ionic", version }`, `app: { name, package_name, platform, version, build_number }`
(from the binary, nulls omitted), `events`. No `session`, `location`, `app.environment`,
`sdk.platform`. `sdk.version` = package version (V3, `scripts/set-version.mjs`).

### ID formats

| ID | Format | Owner |
|---|---|---|
| `device_id` | `device_<epochMs>_<16 hex>_<android\|ios>` (Android UUID v4 fallback); Keychain / SharedPreferences; new on `reset()` | native |
| `session.id` | `session_<epochMs>_<16 hex>_<platform>`; rotates after 30 min idle | native |
| `trace.id` / `span.id` | 32 / 16 lowercase hex, `crypto.getRandomValues`, all-zero rejected; `rum.action.id` = root `span.id` | JS |
| `traceparent` | `00-<trace.id>-<span.id>-01` | JS |

### Offline queue (spec T1, S3)

- JS: in-memory buffer, 500 rows drop-oldest (`js_buffer_full`); hands off via `enqueue` every 2 s /
  20 rows / `app.crash` / `visibilitychange→hidden` / `appStateChange→inactive`.
- Native outbox: NDJSON segments under `files/edge_rum` (Android) / `Application Support/edge_rum`
  (iOS); line 1 = frozen identity. Sealed at 50 rows, 30 s, background, or next launch. Crash, ANR,
  hang, WebView death = solo segments. Caps 5 MB / 200 segments (`outbox_full`), 7 days (`expired`).
- Send: one in flight, oldest first. 2xx delete; 4xx (not 429) delete + `rejected`; 429/5xx/network
  retry 1 s / 4 s / 16 s + jitter, `Retry-After` honoured, then parked and retried on a 30 s tick.
- Per-session caps: non-fatal `app.crash` 50 (5 per key), `ui.interaction` 200, `bridge.summary` 50,
  custom + `task.complete` + non-vitals numeric rows 500. Drops → `sdk.health` `events_dropped.*`.

### Bundle rules (spec K4, L1–L4)

- `sideEffects: false`; `@capacitor/*`, `@angular/*` peers; only runtime dep is `web-vitals`.
- No OpenTelemetry, no JS transport/queue/session/ID generation, no lazy `import()` of captures.
- Captures are tree-shakeable imported factories; errors + requests always in core.

### Native config block (spec C1)

```ts
// capacitor.config.ts → plugins.EdgeRum (read at launch, before JS)
{ apiKey, endpoint, enabled: true, sampleRate: 1.0, anr: true, anrTimeoutMs: 5000 /* Android */,
  hang: true, hangTimeoutMs: 2000, memorySampling: false, memorySamplingIntervalMs: 30000 }
```

`init({ apiKey, endpoint })` overrides for one launch only (not persisted). Spec C1's native
`debug` key is not read by either platform; `debug` is JS-only.

---

## Public API (spec C2–C6, ADR-040/046)

```typescript
EdgeRum.init({ apiKey?, endpoint?, captures?, traceHostAllowlist?, ignoreUrls?, sanitizeUrl?,
               beforeSend?, release?, debug? })   // fails open, never throws (C5)
EdgeRum.identify({ id?, name?, email?, phone? }) / clearUser()
EdgeRum.track(name, attrs?) / measure(name, value, attrs?) / time(name).end(attrs?)
EdgeRum.trackScreen(name, attrs?) / captureError(err, attrs?)
EdgeRum.startTask(name, attrs?) / completeTask(name) / failTask(name, reason?)
EdgeRum.markReady() / setAttribute(k, v) / removeAttribute(k)
EdgeRum.enable() / disable() / reset() / getSessionId(): Promise<string>
```

- Every method is sync, fire-and-forget, safe before native is ready, and a no-op on web.
- Captures are imported factories: core `vitals()`, `interactions()`, `frames()`, `longTasks()`,
  `resourceTiming()`, `consoleErrors()`, `defaultCaptures()`; `-capacitor` `bridge()` and its own
  `defaultCaptures()` (core's + `bridge()`). Plain `init()` runs errors + requests only;
  `provideEdgeRum()` defaults to `-capacitor`'s `defaultCaptures()` (ADR-046).
- Launch-time switches (`sampleRate`, `enabled`, ANR/hang, memory sampling) are native config only (C1).
- `EdgeRumService` mirrors every `EdgeRum` method with no logic.

---

## Repository structure

```
packages/
  core/src/
    index.ts           ← PUBLIC BOUNDARY
    core.ts            ← native relay: buffer, hand-off, consent state, zone escape
    EdgeRum.ts         ← public methods + internal __hooks for -angular
    captures.ts        ← capture factories
    beforeSend.ts
    instrumentation/   ← errors, requests, vitals, interactions, frames, perf-observer
    internal/          ← breadcrumbs, health (ADR-031 breaker)
  capacitor/
    src/index.ts       ← bridge(), defaultCaptures()
    android/           ← Kotlin plugin + core (com.nathanclaire.rum), core-test (JUnit, goldens)
    ios/               ← Swift plugin + Core/, core-test (XCTest, goldens)
  angular/src/         ← EdgeRumModule / provideEdgeRum, EdgeRumService, Router/Ionic/Error capture
e2e/                   ← fake Capacitor bridge → mock-ingest; bridge spec (A2 table); L3 bench;
                         device/gate.mjs (Q3 device e2e)
demo/                  ← Ionic Angular app on provideEdgeRum, one button + deep link per scenario (Q1);
                         scenarios/ = its native plugin; native projects generated by scripts/demo-build.sh
docs/                  ← spec.md, decisions.md, release-checklist.md, research/, agents/;
                         consumer: events.md, config-reference.md, privacy.md, migration-5.md,
                         payload-schema.json; maintainer: terminology.md
```

---

## Conventions

**TypeScript:** `strict`; no `any` (use `unknown`); no non-null assertion without a comment saying
why; no `enum` (use `as const` objects + derived unions); public types exported from `index.ts`.

**Errors:** never throw to consumers. Internal failures are caught and swallowed; log only when
`debug` is on, prefixed `[edge-rum]`.

**Capacitor:** reach native through the `Capacitor` global, never assume it exists; never return a
plugin proxy from a promise (its `.then` breaks `await`).

**Angular:** never import `@angular/*` in core. `APP_INITIALIZER` boots the SDK, inside
`runOutsideAngular` (spec A8). Route names are normalised templates (`/products/:id`), never raw URLs.

**Zones:** every SDK timer, listener and rAF loop runs outside NgZone (spec A8).

**Tests:** Vitest in Node with the fake bridge (`packages/core/test/core.test.ts`,
`packages/angular/test/fake-native.ts`). Native goldens per event type (spec Q2). Payload tests ban
camelCase `traceId` / `spanId` / `resourceSpans` / `opentelemetry` and assert flat attributes.

---

## Budgets (spec L1, L3)

- Size (gzip): core 14 KB, `-capacitor` own 7 KB, `-angular` own 4 KB, full stack 24 KB,
  minimal (`init` + errors + requests) 8 KB. Raising one needs an ADR line.
- Runtime (Playwright + CDP, 4× throttle, median of 5): eval + `init()` ≤ 8 ms, `track()` ≤ 10 µs,
  idle ≤ 1 ms per 10 s static screen, heap after init + 2,000 events ≤ +2 MB.
- No OpenTelemetry dependency (spec L4). `sideEffects: false`; `@capacitor/*`, `@angular/*` are peers.

---

## Checks (all must pass before a PR)

```
pnpm lint && pnpm type-check && pnpm test && pnpm build
pnpm terminology-check && pnpm attribute-flatness-check && pnpm pack-audit && pnpm size
pnpm test:integration        # Playwright: bridge spec + L3 bench
pnpm test:android / test:ios # native core suites
pnpm e2e:device android|ios  # Q3 device gate (emulator / simulator booted); nightly in CI
```

**Releasing (spec V2, V3):** `pnpm set-version X.Y.Z[-rc.N]` (all three packages + the copies native
can't read from package.json), a `## X.Y.Z` section in the root `CHANGELOG.md` (an rc uses its base
version's section), every box in `docs/release-checklist.md`, then push tag `vX.Y.Z` on main.
`.github/workflows/release.yml` publishes via npm trusted publishing; `-rc.N` → `next`.

---

## When in doubt

1. Public surface? → Rule 1.
2. Touches the wire? → spec §4/§7, then native owns it unless it's WebView capture.
3. New event name / key? → spec or ADR first.
4. Non-obvious choice? → ADR in `docs/decisions.md`.
5. Commit or PR? → Rule 3: no AI attribution.

---

## Agent skills

- **Issue tracker:** GitHub issues on `NCG-Africa/edge_telemetry_ionic_angular_capacitor` via `gh`;
  external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.
- **Triage labels:** `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
  See `docs/agents/triage-labels.md`.
- **Domain docs:** single context; ADRs in `docs/decisions.md`. See `docs/agents/domain.md`.

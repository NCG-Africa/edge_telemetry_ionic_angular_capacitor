# Release checklist

Spec Q1 (Cordova Q6), Q3 and V3. Copy this list into the release PR and tick every box there. Don't push a
`v*.*.*` tag until every box is ticked. The device e2e gate (Q3) automates only the happy path on an
emulator and a simulator; the scenario table covers the rest by hand on a **real** Android phone and a
**real** iPhone.

## Backend gate (spec G0, G10, V3)

- [ ] **G0:** prod runs collector PR #8 and processor PR #9 (otherwise contract-4 batches go to the DLQ as `<app-not-registered>`).
- [ ] **G10:** the processor halves of G1–G5, G7 and G8 are live in prod. Analytics may trail.
- [ ] **Catalogue (ADR-050):** prod runs the processor release that reads catalogue 4.7. A build
  sending the catalogue names (`app.error`, `custom.event`, `perf.*`, `memory.usage`, …) must not ship
  before it.

## Catalogue conformance gate (ADR-050)

Spec 2026-11-23 stable goldens (AC-7). The pin moves only here, never in a feature PR.

- [ ] Every catalogue change this release needs is tagged `catalogue-v4.N` in the processor repo. If
  not, cut the tag there first.
- [ ] `catalogue.version` names that `catalogue-v4.N` tag, not `main` or a branch.
- [ ] `scripts/conform.sh` on this commit prints `conforms to catalogue 4.N` and `shape matches` for
  all three sets (needs pnpm, gradle with JDK 17, swift, `go` and read access to the processor repo;
  `PROCESSOR_DIR=<checkout>` reuses a local one). Local only: the processor repo is private, so CI
  can't clone it. An intended wire change: `scripts/conform.sh -update`, and commit the shape diff
  with the change.

## Device e2e gate (spec Q3)

- [ ] Both local runs on this commit print `[gate] <platform> OK` with an emulator and a simulator booted:
  `pnpm e2e:device android` and `pnpm e2e:device ios`.

## Setup for the manual run

1. Start mock-ingest on a laptop on the same network as the phones: `node e2e/mock-ingest-server.mjs`.
2. Build the demo pointed at it, for each platform:
   ```sh
   EDGE_RUM_ENDPOINT=http://<laptop LAN ip>:4319/collector/telemetry scripts/demo-build.sh android
   EDGE_RUM_ENDPOINT=http://<laptop LAN ip>:4319/collector/telemetry scripts/demo-build.sh ios
   ```
3. Install on the phones: `cd demo && npx cap run android --target <device id>`; for iOS run
   `npx cap open ios`, set a signing team and run on the phone.
4. Each scenario is a button on the home screen and a route of the same name. Run one, then send the app
   to the background so the batch seals and sends (spec T3). Read what arrived with
   `curl -s localhost:4319/__requests | jq '.requests[].parsed.events[] | {eventName, metricName, attributes}'`,
   and clear it between scenarios with `curl -X POST localhost:4319/__reset`.

Every batch must also have: `Content-Encoding: gzip`, `sdk.name = ionic`, `contract_version = 4.3.0`,
`app.platform` matching the phone, and the same `device_id` across launches.

## Scenarios

| Scenario | Do | Expect | Android | iOS |
|---|---|---|---|---|
| `happy` | Tap it | `session.started`, `app.start` with phase keys incl. `app.start.bridge_ready_ms`, `navigation` to `/happy` with `navigation.{guards_ms,resolvers_ms,chunk_load_ms}`, `http.request` for `ping.json` with `traceparent.outcome = injected_*`, `bridge.summary` for `DemoScenarios` / `slow` | [ ] | [ ] |
| `js-error` | Tap it | `app.crash` with `error.cause=unhandled_exception`, `error.source=webview`, frames as `app:///…` in `error.stacktrace`, `error.breadcrumbs` | [ ] | [ ] |
| `native-crash` | Tap it (the app dies), then open the app again | On relaunch: `app.crash` from the native handler, alone in its batch (no `sdk.health`), with the native breadcrumbs | [ ] | [ ] |
| `renderer-kill` | Tap it | `app.crash` with `error.cause=webview_terminated`, `screen.name=/renderer-kill`; Android `webview.detected_by=callback`, iOS `webview.detected_by=inference` (if the app shows a blank page, open it again) | [ ] | [ ] |
| `hang` | Tap it, keep the app open for 7 s | Android: `app.anr` (`anr.duration_ms` ≥ 5000) and `app.hang`; iOS: `app.hang` (`hang.duration_ms` ≥ 2000) | [ ] | [ ] |
| `slow-bridge` | Tap it, then go back | `bridge.summary` for `DemoScenarios` / `slow` with `bridge.max_ms` ≥ 1500. No `bridge.call` (E18) | [ ] | [ ] |
| `offline` | No toggle in the app: turn on airplane mode, tap it, background the app, turn airplane mode off, open the app | Nothing arrives while offline; afterwards the 30 `custom.event`s (`event.name=offline.burst`) arrive once each (offline replay, R12) | [ ] | [ ] |
| `rage-tap` | Tap it (or tap “Does nothing” three times fast) | `ui.interaction` with `ui.rage=true` and `ui.dead=true` | [ ] | [ ] |
| `mark-ready` | Kill the app, open it, tap it within 30 s | That launch's `app.start` has `app.start.mark_ready_ms`, and `app.start.duration_ms` equals `app.start.bridge_ready_ms` | [ ] | [ ] |
| `task` | Tap it | `task.complete` with `task.name=checkout`, `task.outcome` completed, `span.duration_ms` ≈ 500 | [ ] | [ ] |
| `caps` | Tap it | `custom.event`s stop at the per-session cap (500, shared with `task.complete` and host measures), and `sdk.health` counts the rest as `cap.custom` (100 in a session with nothing else) | [ ] | [ ] |
| 5xx retry (R12) | `curl -X POST 'localhost:4319/__status?code=503'`, tap `task`, background the app; then `curl -X POST 'localhost:4319/__status?code=200'` and open the app | While 503: the same batch is retried (several requests in `__requests`). After: it arrives and is accepted once | [ ] | [ ] |
| 4xx drop (R12) | `curl -X POST 'localhost:4319/__status?code=400'`, tap `task`, background; set `code=200`, tap `task`, background | The 400 batch is not retried; the next accepted batch has `sdk.health` with `rejected` ≥ 1 | [ ] | [ ] |

## Deep links

Each scenario also runs from a deep link with the same name. Check one per platform:

- [ ] Android: `adb shell am start -n com.nathanclaire.rum.demo/.MainActivity --es scenario task`
- [ ] iOS: open `edgerumdemo://task` in Safari on the phone

## Cutting the release (spec V2)

- [ ] One-time: a tag ruleset on this repo limits creating `v*` tags to maintainers (Cordova V2).
- [ ] One-time: each of the three packages on npmjs.com names this repo and
  `.github/workflows/release.yml` as a trusted publisher (no `NPM_TOKEN`).
- [ ] `pnpm set-version 5.0.0-rc.N` (or `5.0.0` for GA) committed in the release PR; `pnpm test`
  passes (`test/version-sync.test.ts`).
- [ ] Root `CHANGELOG.md` has a `## 5.0.0` section; it becomes the GitHub Release body.
- [ ] After merge: `git tag v5.0.0-rc.N origin/main && git push origin v5.0.0-rc.N`. The workflow re-runs
  CI, the device gate and both native fixtures, checks the tag against every package version, then
  publishes all three packages (`-rc.N` → `next`) and creates the GitHub Release.
- [ ] Measured native load time, IPA / APK size delta and battery (spec L3) added to the `## 5.0.0`
  CHANGELOG section before tagging, so they land in the release notes.

## Rollout (spec V3)

1. [ ] Every box above is ticked in the release PR.
2. [ ] `5.0.0-rc.N` published on the npm `next` dist-tag.
3. [ ] One internal pilot app runs the RC in production for ~1 week.
4. [ ] GA: pilot batches land in the G tables with zero DLQ. GA freezes 4.x (M1).

# Release checklist

Spec V2 and V3. Copy this list into the release PR and tick every box there. Don't push a
`v*.*.*` tag until every box is ticked. The device e2e run (`pnpm e2e:device`) and the demo scenarios
are optional tools, not release gates.

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

## Runtime bench (spec L3)

- [ ] `pnpm test:integration` on this commit passes locally, including `L3 runtime ceilings`. CI skips the
  bench: shared runners are too slow and noisy for its CPU-time ceilings.

## Cutting the release (spec V2)

- [ ] One-time: a tag ruleset on this repo limits creating `v*` tags to maintainers (Cordova V2).
- [ ] One-time: each of the three packages on npmjs.com names this repo and
  `.github/workflows/release.yml` as a trusted publisher (no `NPM_TOKEN`), with the **npm publish** permission
  (stage publish alone makes the job fail with `403 OIDC permission denied`, or leaves the version staged).
- [ ] `pnpm set-version 5.0.0-rc.N` (or `5.0.0` for GA) committed in the release PR; `pnpm test`
  passes (`test/version-sync.test.ts`).
- [ ] Root `CHANGELOG.md` has a `## 5.0.0` section; it becomes the GitHub Release body.
- [ ] After merge: `git tag v5.0.0-rc.N origin/main && git push origin v5.0.0-rc.N`. The workflow re-runs
  CI, checks the tag against every package version, then
  publishes all three packages (`-rc.N` → `next`) and creates the GitHub Release.
- [ ] Measured native load time, IPA / APK size delta and battery (spec L3) added to the `## 5.0.0`
  CHANGELOG section before tagging, so they land in the release notes.

## Rollout (spec V3)

1. [ ] Every box above is ticked in the release PR.
2. [ ] `5.0.0-rc.N` published on the npm `next` dist-tag.
3. [ ] One internal pilot app runs the RC in production for ~1 week.
4. [ ] GA: pilot batches land in the G tables with zero DLQ. GA freezes 4.x (M1).

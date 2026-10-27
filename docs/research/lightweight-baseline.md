# Lightweight baseline: what edge-rum 4.0.0 costs the host app

Ticket #71 (wayfinder map #68). Research only. As of 2026-10-27, Ionic HEAD `fd2778d`.

## Summary

- **Size is not the problem.** Full stack is ~21–28 KB gzip against a 200 KB budget (14%). Core is 12.5 KB, of which `web-vitals` is 2.6 KB. No OpenTelemetry remains in any bundle or dependency.
- **The `.size-limit.json` budgets are ~5× too loose to guard anything.** Core 90 KB / Angular 60 / Capacitor 60 / full 200 would let the SDK quadruple before CI noticed. They date from when OTel was bundled (`noExternal: [/@opentelemetry/]` in `CLAUDE.md` is stale).
- **Core does not tree-shake.** `import { EdgeRum }; EdgeRum.init()` keeps 97% of core (12.19 of 12.53 KB). `init()` wires every capture unconditionally, so `sideEffects: false` buys nothing. Opt-out flags (`captureFrames: false`) skip work but not bytes.
- **Startup is cheap.** Script eval 0.5 ms + `init()` 1.2–2.3 ms on desktop Chrome; 2.4 + 5 ms at 4× CPU throttle (≈ mid-range Android). Init is synchronous and does no I/O on the critical path (queue load, location lookup are deferred/async).
- **Per-event hot path is cheap but every event is fat.** `track()` costs ~1.7 µs (6.6 µs at 4×). Each event serialises to ~555 bytes because ~13 identity attributes are copied onto every event. That is a wire-size cost, not CPU, and contract 4 (R1, identity in envelope) removes most of it.
- **The biggest steady-state cost is per-frame work, and on native it runs twice.** The JS `requestAnimationFrame` loop runs every frame for the life of the app (~10 µs/frame, ~6 ms of script per 10 s idle on desktop). On iOS/Android the native `CADisplayLink` / `Choreographer` sampler runs as well, both default-on. Nothing pauses the JS loop when the screen is static.

## Method

All numbers are from this repo's build (`pnpm build`) on an Apple-silicon Mac. Scripts are throwaway (session scratchpad), not committed.

- **Size:** `pnpm size` (size-limit, esbuild preset) for the official numbers. For per-package and attribution, esbuild `--bundle --minify` with peers external, `gzip -9`, plus esbuild metafile.
- **Runtime:** Chrome (stable, headless) via Playwright, core IIFE injected into a blank page, CDP `Emulation.setCPUThrottlingRate` 1× and 4×, CDP `Performance.getMetrics` (`ScriptDuration`, `TaskDuration`) over a 10 s idle window. Two runs per config; numbers below are ranges.
- **Not measured:** native plugin load time, native binary size, battery. These need a device run (see Open questions).

## Size

| Bundle | min | gzip | Budget (`.size-limit.json`) |
|---|---|---|---|
| core incl. `web-vitals` (size-limit) | — | 15.9 KB | 90 KB |
| core incl. `web-vitals` (esbuild, -9) | 41.4 KB | 12.5 KB | |
| ↳ `web-vitals` alone | 7.2 KB | 2.6 KB | |
| Capacitor own code (core external) | 18.2 KB | 6.0 KB | 60 KB |
| Angular own code (core external) | 7.4 KB | 2.4 KB | 60 KB |
| **Full stack, deduped** | | **~21 KB** | |
| Full stack (size-limit, as configured) | | 28.0 KB | 200 KB |

size-limit's per-package rows include core (Angular row = 17.9 KB = core + Angular). The 28 KB full-stack row is the official CI number; ~21 KB is what an app actually ships once core is deduped.

**Core attribution (bytes in minified output):**

| Module | bytes |
|---|---|
| `EdgeRum.ts` (facade + `init` wiring) | 7,371 |
| `web-vitals` | 5,887 |
| `queue/OfflineQueue.ts` | 3,643 |
| `session/SessionManager.ts` | 3,205 |
| `internal/pipeline.ts` | 2,510 |
| `instrumentation/errors.ts` | 1,976 |
| `internal/collector.ts`, `context.ts`, `health.ts` | ~1,400–1,550 each |
| `perf-observer`, `interactions`, `frames`, `locationResolver`, `pageload` | ~1,100–1,400 each |

No single module dominates. There is no fat dependency to cut.

**Dependencies:** core → `web-vitals ^4.2.4` (only runtime dep); optional peer `@capacitor/preferences`. Capacitor → `@capacitor/{core,device,network,app}` peers, all dynamic `import()` (lazy). Angular → `@angular/{core,router}` peers. Zero OTel anywhere (`grep -c opentelemetry` on dist = 0; no OTel in any `package.json`).

**Tree-shaking:**

| Entry | gzip |
|---|---|
| all of core | 12.53 KB |
| `EdgeRum.init` only | 12.19 KB |
| `EdgeRum.track` only | 12.19 KB |

The facade object holds every method and `init()` imports every capture. A consumer cannot drop frames, memory, interactions, resource timing, location resolution or web-vitals from the bundle.

## Runtime (JS, Chrome)

| | 1× | 4× throttle |
|---|---|---|
| Script eval | 0.5 ms | 2.4 ms |
| `init()` | 1.2–2.3 ms | 5.0 ms |
| `track()` per call | 1.6–2.3 µs | 6.6 µs |
| Click capture overhead per click | +0.45 µs | +2.0 µs |
| `fetch` wrapper overhead | below noise (±150 µs network jitter) | below noise |
| JS heap after init + 2,000 events | +1.6 MB | +1.7 MB |

**Idle main-thread cost (10 s, static page, 1×):**

| Config | script ms / 10 s |
|---|---|
| baseline page (no SDK) | 8.9–10.9 |
| SDK, defaults | 16.2–18.4 |
| SDK, `captureFrames: false` | 10.5–11.9 |
| SDK, frames + memory off | 8.2–9.0 |

So ~6–7 ms of script per 10 s idle is the SDK, almost all of it the rAF loop. It is ~0.07% CPU on desktop. The concern is not the percentage but that it **wakes JS on every vsync forever**: it keeps a static Ionic screen from ever being idle, which matters for battery on 120 Hz devices and low-end Android more than for throughput.

**Payload shape (per event, current 3.1 wire):** ~555 bytes JSON, 16 attributes of which ~13 are identity/context copied from `ContextManager`. 30-event batch ≈ 16.7 KB uncompressed (no compression by Rule 2).

**Volume amplifiers (not CPU, but host-visible):** the resource-timing observer emits one `resource_timing` metric per resource with no sampling or cap, and with the raw URL (`metric.resource_name`, perf-observer.ts:77) — `sanitizeUrl` is not applied. An image-heavy list screen can generate hundreds of events.

## Native side (inventory, not measured)

| Platform | Always-on work (defaults) |
|---|---|
| iOS | PLCrashReporter (SwiftPM dep, signal handlers); `HangDetector` main-thread heartbeat; `CADisplayLink` every frame (`FrameSampler.swift:64`); `MemorySampler` dispatch timer every 10 s + pressure source |
| Android | JVM uncaught handler; NDK signal handler (`cpp/native-crash.cpp`, adds a `.so` per ABI); `AnrWatchdog` thread waking every `max(timeout/2, 500)` ms (`AnrWatchdog.kt:29`); `Choreographer` callback every frame (`FrameSampler.kt:50`); `MemorySampler` every 10 s |
| WebView (JS) | rAF every frame; `performance.memory` every 10 s; longtask + resource observers |

On a device, frames are sampled by **both** JS rAF and the native sampler, and memory by both the JS and native samplers. That is two per-frame callbacks on the main thread plus a bridge hop for native summaries.

## Comparison with other SDKs

JS gzip only; native binaries excluded. **M** = measured by esbuild `--bundle --minify` + `gzip -9` with Angular/rxjs/`@capacitor/core` external (same method as above); **V** = vendor CI/docs; **BP** = bundlephobia (whole package, worst case). Fetched 2026-10-27.

| SDK / config | Version | gzip KB | Src | Tree-shake |
|---|---|---|---|---|
| **edge-rum full stack** | 4.0.0 | **~21** (28 size-limit) | M | no |
| Sentry `@sentry/capacitor` + `@sentry/angular`, errors | 4.4.0 / 10.69.0 | 44.1 | M | yes |
| ↳ + tracing | | 60.9 | M | |
| ↳ + tracing + replay | | 102.1 | M | |
| `@sentry/browser` errors / +tracing / +replay | ≈11.9 | 30.0 / 52.2 / 92.0 | V | yes (build flags) |
| Datadog `@datadog/browser-rum` (npm) | 7.16.1 | 84.2 (CDN 65.4) | M | poor (monolith) |
| Datadog `@datadog/browser-rum-slim` | 7.16.1 | 57.2 (CDN 50.4) | M | poor |
| Embrace `@embrace-io/web-sdk` | 2.31.0 | 62.2 | M | weak — 11 of 14 deps are OTel |
| Embrace Capacitor | — | no npm package found | — | — |
| Firebase `firebase/app` + `getPerformance` | 13.1.0 | 20.2 | M | yes (modular) |
| `@capacitor-firebase/performance` JS bridge | 8.5.2 | 0.3 (+ native SDK) | BP | — |
| OTel minimal (WebTracerProvider + batch + OTLP-http) | 2.12 / 0.223 | 20.1 | M | moderate |
| `web-vitals` (all five) | 6.2.3 | 3.5 | M | yes |

Takeaways:

- edge-rum is already the smallest full RUM in the field — about half of Sentry errors-only, a third of Datadog slim. Only Firebase Perf is comparable, and it does far less.
- **An OTel-based trace implementation would roughly double edge-rum** (+20 KB minimum) — Embrace shows where that leads (~60 KB). Supports the #70 finding that trace v3 should be hand-written attributes, not an OTel SDK.
- Sentry's +17 KB for tracing is the reference ceiling for what "adding traces" costs a mature SDK; edge-rum's trace v3 (ids + `traceparent` header + ambient root) should land well under that.
- Nobody publishes credible runtime-overhead numbers. Sentry's replay benchmark (TBT 2622→3037 ms on their own UI) is the only one found; "imperceptible" claims are unquantified. edge-rum publishing its own (this doc) would be a differentiator.
- Tree-shakeable capture modules are standard at Sentry/Firebase; edge-rum and Datadog are monoliths.

Sources: [sentry-javascript `.size-limit.js`](https://github.com/getsentry/sentry-javascript/blob/develop/.size-limit.js), [size-limit report on PR #25741](https://github.com/getsentry/sentry-javascript/pull/25741), [Sentry replay overhead](https://docs.sentry.io/product/session-replay/web/performance-overhead/), [Sentry tree-shaking](https://docs.sentry.io/platforms/javascript/configuration/tree-shaking/), [DataDog/browser-sdk](https://github.com/DataDog/browser-sdk), [Datadog CDN v7 bundle](https://www.datadoghq-browser-agent.com/us1/v7/datadog-rum.js), [bundlephobia](https://bundlephobia.com/), [npm `@embrace-io/web-sdk`](https://registry.npmjs.org/@embrace-io/web-sdk/latest). Runtime-overhead claims for Datadog, Embrace and Firebase: unverified (none published).

## Cost drivers, ranked

1. **Per-frame work, doubled on native.** JS rAF loop never idles; native `CADisplayLink`/`Choreographer` runs too. Highest steady-state CPU and the only battery-relevant item. Lever: one frame source per platform (native on device, rAF on web), and pause rAF when no interaction/route change for N s.
2. **Per-event identity duplication on the wire.** ~13 of 16 attributes repeated per event → ~3–4× wire bytes vs. needed. Lever: contract-4 envelope identity (R1) — already in scope.
3. **Unsampled, unsanitised resource timing.** Event-count amplifier and a privacy leak. Lever: cap/sample, apply `sanitizeUrl`, or fold into a per-screen summary.
4. **No tree-shaking — all captures ship regardless of config.** ~12 KB floor for any use. Lever: per-capture opt-in modules (e.g. `init({ captures: [...] })` with imported capture functions) so unused captures drop out. Matters more once traces, `app.start`, WebView-health etc. are added in 5.0.
5. **Budgets too loose to enforce "lightweight".** Lever: re-baseline `.size-limit.json` to current + headroom (e.g. core 16, Capacitor 8, Angular 4, full 30 KB) and add a hot-path benchmark gate.
6. **Duplicate memory sampling (JS + native) and always-on watchdogs.** Small; flag for the catalogue decision.

Init time, `track()` cost, click and fetch wrappers are all small enough not to rank.

## Open questions

- **Device numbers.** Native plugin `load()` time, IPA/APK size delta of PLCrashReporter + NDK `.so`, and battery with rAF + native frame sampling, need a run on a low-end Android and an iPhone. Candidate HITL task if the budget decision needs them.
- **Is double frame sampling intentional?** ADR-030 makes web and native share one shape; it doesn't say whether both should run on device.
- **`CLAUDE.md` bundle rules are stale** (`noExternal` OTel; "core < 90KB"). Rewrite when the budget is decided.

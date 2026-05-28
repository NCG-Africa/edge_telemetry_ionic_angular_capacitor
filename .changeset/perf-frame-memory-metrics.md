---
'@nathanclaire/rum': minor
'@nathanclaire/rum-capacitor': minor
---

feat: emit `frame_render_time` and `memory_usage` metrics so the EdgeTelemetryProcessor's `/sessions/{id}/performance` endpoint returns real frame buckets and a memory timeline.

**New metric items** (`type: "metric"`):

- `frame_render_time` — value is total frame interval in ms. Attributes use the processor's preferred dotless keys: `unit: "ms"`, `frame_build_duration` (number), `frame_raster_duration` (number), `frame_type` (`"ui"`), `frame_dropped` (boolean). Build / raster durations are **always numbers, never null**; `frame_dropped` is **always boolean, never omitted**.
- `memory_usage` — value is megabytes at the top-level `value`. Attributes: `unit: "MB"`, `memory_pressure_level` (`"normal" | "moderate" | "high" | "critical"`, omitted when unknown), `memory_type` (`"heap" | "rss" | "pss"`), `memory_source` (`"javascript" | "native"`).

**Three frame sources, one wire shape:** WebView `requestAnimationFrame` + Long Tasks overlap (web + native fallback); iOS `CADisplayLink`; Android `Choreographer.FrameCallback`. The native paths run via four new methods on the existing `EdgeRumCrash` Capacitor plugin: `startPerfSampling`, `stopPerfSampling`, `fetchFrameSamples`, `fetchMemorySamples`. By default only frames whose interval exceeds `frameSlowThresholdMs` (16.67ms) are emitted — idle screens cost nothing on the wire.

**Memory cadence:** periodic every `memorySamplingIntervalMs` (default 10s) plus an immediate sample on every memory-pressure callback and every foreground/background transition.

**New `EdgeRumConfig` fields** (all optional, all default to on/sensible values):

- `captureFrames?: boolean` (default `true`)
- `captureAllFrames?: boolean` (default `false`, debug-only)
- `frameSlowThresholdMs?: number` (default `16.67`)
- `captureMemory?: boolean` (default `true`)
- `memorySamplingIntervalMs?: number` (default `10_000`)

**`SDK_VERSION`** bumped to `3.4.0`. Existing dotted attribute keys on Web Vitals / `long_task` / `resource_timing` / `EdgeRum.time()` are unchanged — only the two new metrics use the dotless convention. See `docs/decisions.md` ADR-027 for the build/raster split rationale and the iOS / Android pressure-level mapping tables.

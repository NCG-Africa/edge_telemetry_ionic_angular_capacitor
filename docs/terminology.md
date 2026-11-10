# Terminology

Maintainer reference for the terminology firewall (spec N3, ADR-033). Applies to the **public
surface**: `packages/*/src/index.ts` exports, `.d.ts` output, READMEs, consumer docs
(`docs/events.md`, `privacy.md`, `config-reference.md`, `migration-5.md`, `CHANGELOG.md`), and any
error or `console.*` text a consumer can see. Internal code, ADRs and this file may use any word.

## Banned

| Term | Why | Say instead |
|---|---|---|
| `opentelemetry`, `otel`, `otlp`, `tracer`, `TracerProvider`, `SpanProcessor`, `SpanExporter`, `MeterProvider`, `LoggerProvider` | OpenTelemetry identity: we don't ship or depend on it (L4) | — |
| telemetry | Brand voice | "data", "performance data", "monitoring" |
| instrumentation | Brand voice | "capture", "captures" |
| sampling | Brand voice | "share of sessions kept" (`sampleRate` is fine as a key) |
| batch | Brand voice | "data is sent", "request" |
| flush | Brand voice | "send" |
| collector, pipeline | Brand voice | "backend", "ingest" |
| metric, metrics (API names, prose) | Brand voice | "reading", "performance data" |

**Allowed:** `trace`, `span`, `tracing`, `traceparent`.

**Sanctioned exceptions — literal wire values only, in code spans:** `type: 'metric'`, `metricName`,
`metric.unit`, `metric.rating`, `telemetry_batch`, `/collector/telemetry`, the
`edgetelemetry.ncgafrica.com` host, and removed 4.x option names in the migration guide
(`flushIntervalMs`, `batchSize`, …).

## Enforcement

- `pnpm terminology-check` (`scripts/terminology-check.mjs`): OpenTelemetry identifiers in built `.d.ts`.
- `test/docs-terminology.test.ts`: banned words in consumer docs and READMEs, outside code spans.
- Payload tests ban camelCase `traceId` / `spanId` / `resourceSpans` / `opentelemetry` on the wire.

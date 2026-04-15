#!/usr/bin/env node
// Fails if OpenTelemetry or OTLP identifiers leak into the public .d.ts surface.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BANNED = /TracerProvider|SpanProcessor|MeterProvider|LoggerProvider|SpanExporter|opentelemetry|otlp|@opentelemetry/i;

const PACKAGES_DIR = new URL('../packages', import.meta.url).pathname;

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.d.ts') || full.endsWith('.d.mts') || full.endsWith('.d.cts')) out.push(full);
  }
  return out;
}

const roots = readdirSync(PACKAGES_DIR).map((p) => join(PACKAGES_DIR, p, 'dist'));
const files = roots.flatMap(walk);

if (files.length === 0) {
  console.error('[terminology-check] no .d.ts files found — run `pnpm build` first');
  process.exit(2);
}

let violations = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (BANNED.test(line)) {
      console.error(`${file}:${i + 1}  ${line.trim()}`);
      violations++;
    }
  });
}

if (violations > 0) {
  console.error(`\n[terminology-check] FAIL: ${violations} banned identifier(s) found in public .d.ts files`);
  process.exit(1);
}

console.log(`[terminology-check] OK — scanned ${files.length} .d.ts file(s), no banned terms found`);

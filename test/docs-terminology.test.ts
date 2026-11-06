import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error -- plain .mjs script, no types
import { releaseNotes } from '../scripts/release-notes.mjs';

const repoRoot = new URL('..', import.meta.url).pathname;

// Consumer-facing docs — subject to the terminology firewall.
// The other files in docs/ (spec, decisions, terminology, release-checklist, research) are for
// maintainers and the backend team; they deliberately reference banned terms.
const consumerDocs = [
  'README.md',
  'packages/core/README.md',
  'packages/capacitor/README.md',
  'packages/angular/README.md',
  'docs/events.md',
  'docs/privacy.md',
  'docs/config-reference.md',
  'docs/migration-5.md',
  'CHANGELOG.md',
];

// Spec N3/N4: OpenTelemetry identity only. `trace`, `span`, `tracing`, `traceparent` are allowed.
// `otel` is omitted: a substring match false-positives on words like "hotel".
const bannedTerms = [
  'opentelemetry',
  'otlp',
  'tracer',
  'tracerprovider',
  'spanprocessor',
  'spanexporter',
  'meterprovider',
  'loggerprovider',
];

// "telemetry" must never appear as prose. The string `/collector/telemetry` and
// the hostname `edgetelemetry.ncgafrica.com` are literal wire-contract values
// inherited from the Android SDK endpoint, so we allow them inside inline code
// spans and fenced code blocks only — and in link targets (the repo URL).
function stripCodeSpansAndBlocks(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/\]\([^)]*\)/g, ']');
}

describe('consumer docs terminology firewall', () => {
  for (const relPath of consumerDocs) {
    describe(relPath, () => {
      const content = readFileSync(join(repoRoot, relPath), 'utf8');
      const prose = stripCodeSpansAndBlocks(content);

      for (const term of bannedTerms) {
        it(`does not contain "${term}" anywhere`, () => {
          expect(content.toLowerCase()).not.toContain(term);
        });
      }

      it('does not contain "telemetry" in prose (allowed only in literal URLs)', () => {
        expect(prose.toLowerCase()).not.toContain('telemetry');
      });

      it('does not mention "instrumentation"', () => {
        expect(content.toLowerCase()).not.toContain('instrumentation');
      });

      // Rule 1 brand voice: allowed only as literal wire values / 4.x option names in code spans.
      // CHANGELOG: only the 5.0.0 section; older entries are history and predate the rule.
      const voiced = relPath === 'CHANGELOG.md' ? stripCodeSpansAndBlocks(releaseNotes(content, '5.0.0')) : prose;
      it.each(['sampling', 'batch', 'flush', 'collector', 'pipeline', 'metric'])(
        'does not use "%s" in prose',
        (word) => {
          expect(voiced.toLowerCase()).not.toContain(word);
        },
      );
    });
  }
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = new URL('..', import.meta.url).pathname;

// Consumer-facing docs — subject to the terminology firewall.
// The other files in docs/ (terminology.md, decisions.md, backend-changes.md,
// payload-schema.json) document internals for maintainers and the backend team;
// they deliberately reference banned terms and are out of scope for this check.
const consumerDocs = [
  'docs/quick-start.md',
  'docs/config-reference.md',
  'docs/backend-integration.md',
  'docs/privacy.md',
  'CHANGELOG.md',
];

const bannedTerms = [
  'opentelemetry',
  'otlp',
  'span',
  'tracer',
  'tracing',
  'spanprocessor',
  'tracerprovider',
  'meterprovider',
];

// "telemetry" must never appear as prose. The string `/collector/telemetry` and
// the hostname `edgetelemetry.ncgafrica.com` are literal wire-contract values
// inherited from the Android SDK endpoint, so we allow them inside inline code
// spans and fenced code blocks only.
function stripCodeSpansAndBlocks(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '');
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
    });
  }
});

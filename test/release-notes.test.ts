import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error -- plain .mjs script, no types
import { releaseNotes } from '../scripts/release-notes.mjs';

const CHANGELOG = '# Changelog\n\n## 5.1.0\n\nnew\n\n## 5.0.0\n\nfirst\n\n### Added\n\n- x\n\n## 4.0.0\n\nold\n';

describe('releaseNotes', () => {
  it('returns the exact section, stopping at the next version', () => {
    expect(releaseNotes(CHANGELOG, '5.0.0')).toBe('first\n\n### Added\n\n- x');
  });

  it('falls back to the base version for a prerelease', () => {
    expect(releaseNotes(CHANGELOG, '5.0.0-rc.2')).toBe('first\n\n### Added\n\n- x');
  });

  it('is empty for an unknown version', () => {
    expect(releaseNotes(CHANGELOG, '9.9.9')).toBe('');
  });

  it('the real CHANGELOG has a section for the current version', () => {
    const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
    const version = JSON.parse(read('packages/core/package.json')).version;
    expect(releaseNotes(read('CHANGELOG.md'), version)).not.toBe('');
  });
});

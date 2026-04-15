import { describe, expect, it } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PACKAGES = ['core', 'angular', 'capacitor'];

// Skip if dist hasn't been built yet — the CI pipeline enforces the full build
// separately; these assertions only validate artifacts when they exist.
const hasAnyDist = PACKAGES.some((p) => existsSync(join(ROOT, 'packages', p, 'dist')));

describe.skipIf(!hasAnyDist)('build artifacts', () => {
  for (const pkg of PACKAGES) {
    describe(`packages/${pkg}`, () => {
      const dist = join(ROOT, 'packages', pkg, 'dist');

      it('emits index.mjs', () => {
        expect(existsSync(join(dist, 'index.mjs'))).toBe(true);
      });

      it('emits index.cjs', () => {
        expect(existsSync(join(dist, 'index.cjs'))).toBe(true);
      });

      it('emits index.d.ts', () => {
        expect(existsSync(join(dist, 'index.d.ts'))).toBe(true);
      });

      it('index.mjs is non-empty', () => {
        const size = statSync(join(dist, 'index.mjs')).size;
        expect(size).toBeGreaterThan(0);
      });
    });
  }
});

import { describe, expect, it } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

// Packages built with tsup produce index.mjs / index.cjs.
// The angular package uses ng-packagr (APF) which produces fesm2022/*.mjs.
const TSUP_PACKAGES = ['core', 'capacitor'];
const ANGULAR_PKG = 'angular';

const ALL_PACKAGES = [...TSUP_PACKAGES, ANGULAR_PKG];

// Skip if dist hasn't been built yet — the CI pipeline enforces the full build
// separately; these assertions only validate artifacts when they exist.
const hasAnyDist = ALL_PACKAGES.some((p) => existsSync(join(ROOT, 'packages', p, 'dist')));

describe.skipIf(!hasAnyDist)('build artifacts', () => {
  for (const pkg of TSUP_PACKAGES) {
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

  describe(`packages/${ANGULAR_PKG}`, () => {
    const dist = join(ROOT, 'packages', ANGULAR_PKG, 'dist');

    it('emits FESM bundle', () => {
      expect(existsSync(join(dist, 'fesm2022', 'nathanclaire-rum-angular.mjs'))).toBe(true);
    });

    it('emits index.d.ts', () => {
      expect(existsSync(join(dist, 'index.d.ts'))).toBe(true);
    });

    it('FESM bundle is non-empty', () => {
      const size = statSync(join(dist, 'fesm2022', 'nathanclaire-rum-angular.mjs')).size;
      expect(size).toBeGreaterThan(0);
    });

    it('contains Ivy partial definitions', () => {
      const { readFileSync } = require('node:fs');
      const content = readFileSync(
        join(dist, 'fesm2022', 'nathanclaire-rum-angular.mjs'),
        'utf-8',
      );
      expect(content).toContain('ɵɵngDeclareFactory');
      expect(content).toContain('ɵɵngDeclareInjectable');
      expect(content).toContain('ɵɵngDeclareNgModule');
    });
  });
});

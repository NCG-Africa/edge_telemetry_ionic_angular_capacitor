import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PACKAGES = ['core', 'angular', 'capacitor'];

const BANNED = /@opentelemetry|\/src\/|\.test\.|tsup\.config|CLAUDE\.md/i;

const hasAllDist = PACKAGES.every((p) => existsSync(join(ROOT, 'packages', p, 'dist', 'index.mjs')));

function packFiles(pkg: string): string[] {
  const cwd = join(ROOT, 'packages', pkg);
  const raw = execSync('npm pack --dry-run --json', { cwd, encoding: 'utf8' });
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return (entry.files ?? []).map((f: { path: string }) => f.path);
}

describe.skipIf(!hasAllDist)('npm pack audit', () => {
  for (const pkg of PACKAGES) {
    describe(`@edgemetrics/rum${pkg === 'core' ? '' : `-${pkg}`}`, () => {
      const files = hasAllDist ? packFiles(pkg) : [];

      it('includes dist/index.mjs', () => {
        expect(files).toContain('dist/index.mjs');
      });

      it('includes dist/index.d.ts', () => {
        expect(files).toContain('dist/index.d.ts');
      });

      it('ships no @opentelemetry node_modules', () => {
        const bad = files.filter((f) => /@opentelemetry/i.test(f));
        expect(bad).toEqual([]);
      });

      it('ships no source files, tests, or build config', () => {
        const bad = files.filter((f) => BANNED.test(f));
        expect(bad).toEqual([]);
      });
    });
  }
});

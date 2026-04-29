import { beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PACKAGES = ['core', 'angular', 'capacitor'];

const BANNED = /@opentelemetry|(^|\/)src\/|\.test\.|tsup\.config|CLAUDE\.md/i;

// Opt-out for local pre-build runs only — CI must always exercise this suite
// against real dist/ artefacts, so a missing build is treated as a test failure.
const SKIP_DIST_CHECK = process.env.SKIP_DIST_CHECK === '1';

function packFiles(pkg: string): string[] {
  const cwd = join(ROOT, 'packages', pkg);
  const raw = execSync('npm pack --dry-run --json', { cwd, encoding: 'utf8' });
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return (entry.files ?? []).map((f: { path: string }) => f.path);
}

describe.skipIf(SKIP_DIST_CHECK)('npm pack audit', () => {
  beforeAll(() => {
    const missing = PACKAGES.filter(
      (p) => !existsSync(join(ROOT, 'packages', p, 'dist', 'index.mjs'))
    );
    if (missing.length > 0) {
      throw new Error(
        `dist/index.mjs missing for: ${missing.join(', ')} — run \`pnpm build\` first, ` +
          `or set SKIP_DIST_CHECK=1 to skip this suite locally`
      );
    }
  });

  for (const pkg of PACKAGES) {
    describe(`@nathanclaire/rum${pkg === 'core' ? '' : `-${pkg}`}`, () => {
      let files: string[] = [];
      beforeAll(() => {
        files = packFiles(pkg);
      });

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

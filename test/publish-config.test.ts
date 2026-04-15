import { beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PACKAGES = ['core', 'angular', 'capacitor'] as const;

const SKIP_DIST_CHECK = process.env.SKIP_DIST_CHECK === '1';

describe('publishConfig on all packages', () => {
  for (const pkg of PACKAGES) {
    it(`${pkg} sets publishConfig.access = 'public'`, () => {
      const pkgJson = JSON.parse(
        readFileSync(join(ROOT, 'packages', pkg, 'package.json'), 'utf8')
      );
      expect(pkgJson.publishConfig).toBeDefined();
      expect(pkgJson.publishConfig.access).toBe('public');
    });
  }
});

describe.skipIf(SKIP_DIST_CHECK)('npm publish --dry-run', () => {
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
    describe(`@edgemetrics/rum${pkg === 'core' ? '' : `-${pkg}`}`, () => {
      const cwd = join(ROOT, 'packages', pkg);
      let files: string[] = [];

      beforeAll(() => {
        const raw = execSync('npm publish --dry-run --json', { cwd, encoding: 'utf8' });
        const parsed = JSON.parse(raw);
        const entry = Array.isArray(parsed) ? parsed[0] : parsed;
        files = (entry.files ?? []).map((f: { path: string }) => f.path);
      });

      it('succeeds and reports files', () => {
        expect(files.length).toBeGreaterThan(0);
      });

      it('excludes src/ from pack output', () => {
        const leaked = files.filter((f) => /(^|\/)src\//.test(f));
        expect(leaked).toEqual([]);
      });

      it('excludes test files from pack output', () => {
        const leaked = files.filter((f) => /(^|\/)test\/|\.test\.(ts|mjs|js)$/.test(f));
        expect(leaked).toEqual([]);
      });

      it('excludes tsup.config and CLAUDE.md', () => {
        const leaked = files.filter((f) => /tsup\.config|CLAUDE\.md/i.test(f));
        expect(leaked).toEqual([]);
      });
    });
  }
});

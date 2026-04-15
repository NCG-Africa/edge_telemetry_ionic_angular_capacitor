#!/usr/bin/env node
// Verifies `npm pack --dry-run` output for every publishable package contains
// no `@opentelemetry` files and no source files — only dist/ artefacts ship.
import { execSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES_DIR = new URL('../packages', import.meta.url).pathname;
const BANNED = /@opentelemetry|\/src\/|\.test\.|tsup\.config|CLAUDE\.md/i;

const packages = readdirSync(PACKAGES_DIR).filter((name) => {
  const pkgJson = join(PACKAGES_DIR, name, 'package.json');
  try {
    statSync(pkgJson);
    return true;
  } catch {
    return false;
  }
});

let totalViolations = 0;

for (const pkg of packages) {
  const cwd = join(PACKAGES_DIR, pkg);
  const raw = execSync('npm pack --dry-run --json', { cwd, encoding: 'utf8' });
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = (entry.files ?? []).map((f) => f.path);

  const violations = files.filter((f) => BANNED.test(f));
  if (violations.length > 0) {
    console.error(`\n[pack-audit] ${pkg} — banned files in npm pack output:`);
    for (const v of violations) console.error(`  ${v}`);
    totalViolations += violations.length;
  } else {
    console.log(`[pack-audit] ${pkg} — OK (${files.length} files, none banned)`);
  }
}

if (totalViolations > 0) {
  console.error(`\n[pack-audit] FAIL: ${totalViolations} banned file(s) would ship to npm`);
  process.exit(1);
}

console.log(`\n[pack-audit] OK — ${packages.length} package(s) audited`);

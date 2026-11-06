#!/usr/bin/env node
// Spec V2 (= Cordova V3, ADR-048): one version for all three packages. Writes it to every copy that can't read
// package.json at build time; `test/version-sync.test.ts` fails if any copy drifts.
// Usage: node scripts/set-version.mjs 5.0.0-rc.1
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/set-version.mjs <x.y.z[-rc.N]>');
  process.exit(1);
}

const edit = (rel, re, to) => {
  const path = join(ROOT, rel);
  const src = readFileSync(path, 'utf8');
  if (!re.test(src)) throw new Error(`${path}: version pattern not found`);
  writeFileSync(path, src.replace(re, to));
};

for (const pkg of ['core', 'capacitor', 'angular']) {
  edit(`packages/${pkg}/package.json`, /("version": )"[^"]+"/, `$1"${version}"`);
}
edit('packages/core/src/index.ts', /(SDK_VERSION = )'[^']+'/, `$1'${version}'`);
edit('packages/capacitor/ios/Plugin/Core/Sender.swift', /(static let packageVersion = )"[^"]+"/, `$1"${version}"`);
console.log(`set ${version}`);

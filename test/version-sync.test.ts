import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Spec V3: the release tag is checked against one version, so every copy must agree.
const ROOT = new URL('..', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const version = JSON.parse(read('packages/core/package.json')).version as string;

describe('version sync', () => {
  it.each(['capacitor', 'angular'])('%s package.json matches core', (pkg) => {
    expect(JSON.parse(read(`packages/${pkg}/package.json`)).version).toBe(version);
  });

  it('core SDK_VERSION matches', () => {
    expect(read('packages/core/src/index.ts')).toContain(`SDK_VERSION = '${version}'`);
  });

  it('iOS Sender.packageVersion matches', () => {
    expect(read('packages/capacitor/ios/Plugin/Core/Sender.swift')).toContain(
      `static let packageVersion = "${version}"`,
    );
  });

  it('podspec and Android read package.json', () => {
    expect(read('packages/capacitor/ios/EdgeRum.podspec')).toContain("package['version']");
    expect(read('packages/capacitor/android/build.gradle')).toContain("file('../package.json')).version");
  });
});

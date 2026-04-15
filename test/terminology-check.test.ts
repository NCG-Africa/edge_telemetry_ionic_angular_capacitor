import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const scriptPath = new URL('../scripts/terminology-check.mjs', import.meta.url).pathname;

function runScriptAgainstDir(dtsContent: string): { code: number; stdout: string; stderr: string } {
  // Stage a fake dist in a tmp workspace that mirrors the script's expectation:
  // <root>/packages/*/dist/*.d.ts. The script derives paths from its own URL,
  // so we instead patch by invoking with a custom cwd and a shim copy.
  const tmp = mkdtempSync(join(tmpdir(), 'edge-rum-term-'));
  try {
    const pkgDist = join(tmp, 'packages', 'fake', 'dist');
    execSync(`mkdir -p ${pkgDist}`);
    writeFileSync(join(pkgDist, 'index.d.ts'), dtsContent);

    // Copy & patch the script to point at tmp/packages
    const shim = readFileSync(scriptPath, 'utf8').replace(
      "new URL('../packages', import.meta.url).pathname",
      JSON.stringify(join(tmp, 'packages')),
    );
    const shimPath = join(tmp, 'check.mjs');
    writeFileSync(shimPath, shim);

    try {
      const stdout = execSync(`node ${shimPath}`, { encoding: 'utf8' });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status: number; stdout: Buffer; stderr: Buffer };
      return {
        code: e.status,
        stdout: e.stdout?.toString() ?? '',
        stderr: e.stderr?.toString() ?? '',
      };
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('terminology-check', () => {
  it('passes on clean public types', () => {
    const result = runScriptAgainstDir(`export declare const SDK_VERSION: string;\n`);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/OK/);
  });

  it('fails when TracerProvider leaks', () => {
    const result = runScriptAgainstDir(`export declare class TracerProvider {}\n`);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/TracerProvider/);
  });

  it('fails when SpanProcessor leaks', () => {
    const result = runScriptAgainstDir(`export interface SpanProcessor {}\n`);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/SpanProcessor/);
  });

  it('fails when opentelemetry identifier leaks', () => {
    const result = runScriptAgainstDir(`// re-export from @opentelemetry/core\n`);
    expect(result.code).toBe(1);
  });

  it('fails when otlp identifier leaks', () => {
    const result = runScriptAgainstDir(`export const endpoint = 'otlp-endpoint';\n`);
    expect(result.code).toBe(1);
  });

  it('is case-insensitive (catches OTLP, OpenTelemetry)', () => {
    const result = runScriptAgainstDir(`export const x = 'OTLP';\n`);
    expect(result.code).toBe(1);
  });
});

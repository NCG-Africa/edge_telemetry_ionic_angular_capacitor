import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scriptPath = new URL('../scripts/attribute-flatness-check.mjs', import.meta.url).pathname;

function runAgainst(fixture: unknown): { code: number; stdout: string; stderr: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'edge-rum-flat-'));
  try {
    const fixturesDir = join(tmp, 'test', 'fixtures');
    mkdirSync(fixturesDir, { recursive: true });
    writeFileSync(join(fixturesDir, 'payload.json'), JSON.stringify(fixture));

    const shim = readFileSync(scriptPath, 'utf8').replace(
      "new URL('..', import.meta.url).pathname",
      JSON.stringify(tmp),
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

const cleanEvent = {
  type: 'event',
  eventName: 'screen_view',
  timestamp: '2024-01-15T10:30:00.000Z',
  attributes: {
    'app.name': 'MyApp',
    'device.isVirtual': false,
    'session.sequence': 1,
  },
};

describe('attribute-flatness-check', () => {
  it('passes with flat primitive attributes', () => {
    const fixture = {
      timestamp: '2024-01-15T10:30:00.000Z',
      type: 'batch', events: [cleanEvent],
    };
    const r = runAgainst(fixture);
    expect(r.code).toBe(0);
  });

  it('fails when an attribute value is an object', () => {
    const fixture = {
      timestamp: '2024-01-15T10:30:00.000Z',
      type: 'batch',
      events: [{ ...cleanEvent, attributes: { device: { model: 'iPhone' } } }],
    };
    const r = runAgainst(fixture);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/device/);
  });

  it('fails when an attribute value is an array', () => {
    const fixture = {
      timestamp: '2024-01-15T10:30:00.000Z',
      type: 'batch',
      events: [{ ...cleanEvent, attributes: { tags: ['a', 'b'] } }],
    };
    const r = runAgainst(fixture);
    expect(r.code).toBe(1);
  });

  it('fails when an attribute value is null', () => {
    const fixture = {
      timestamp: '2024-01-15T10:30:00.000Z',
      type: 'batch',
      events: [{ ...cleanEvent, attributes: { 'user.id': null } }],
    };
    const r = runAgainst(fixture);
    expect(r.code).toBe(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spec E18 / P5 / X6: `bridge()` times every plugin call through `Capacitor.nativePromise`.
type Row = { eventName?: string; attributes: Record<string, unknown> };
type NativePromise = (plugin: string, method: string, options?: unknown) => Promise<unknown>;

const g = globalThis as Record<string, unknown>;
let now = 0;
let rows: Row[] = [];
let pending: { plugin: string; settle: (ok: boolean, value?: unknown) => void }[] = [];

function fakeCapacitor() {
  const plugin = new Proxy({}, {
    get: (_, m) => (arg: { events?: Row[] }) => {
      if (m === 'getState') return Promise.resolve({ enabled: true, sessionId: 's1' });
      if (m === 'enqueue') rows.push(...(arg.events ?? []));
      return Promise.resolve({});
    },
  });
  const nativePromise: NativePromise = (p) => new Promise((resolve, reject) => {
    pending.push({ plugin: p, settle: (ok, v) => (ok ? resolve(v) : reject(v)) });
  });
  g.Capacitor = { isNativePlatform: () => true, registerPlugin: () => plugin, nativePromise };
  return g.Capacitor as { nativePromise: NativePromise };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function load() {
  vi.resetModules();
  const cap = fakeCapacitor();
  const core = await import('@nathanclaire/rum');
  const { bridge } = await import('../src/index');
  core.EdgeRum.init({ captures: [bridge()] });
  await tick();
  return { cap, core };
}

/** Run one call that takes `ms` and settles. */
async function callFor(cap: { nativePromise: NativePromise }, plugin: string, method: string, ms: number, ok = true, value?: unknown) {
  const p = cap.nativePromise(plugin, method, { path: '/secret/file.txt' }).catch(() => undefined);
  now += ms;
  pending.shift()?.settle(ok, value);
  await p;
}

async function handOff(): Promise<Row[]> {
  const d = g.document as EventTarget & { visibilityState: string };
  d.visibilityState = 'hidden';
  d.dispatchEvent(new Event('visibilitychange'));
  d.visibilityState = 'visible';
  await tick();
  const out = rows.filter((r) => r.eventName === 'bridge.summary');
  rows = [];
  return out;
}

beforeEach(() => {
  now = 0;
  rows = [];
  pending = [];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  g.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete g.Capacitor;
  delete g.document;
});

describe('bridge() (E18)', () => {
  it('aggregates calls per plugin + method into one bridge.summary per window', async () => {
    const { cap, core } = await load();
    core.__setCurrentRoute('/camera');
    now = 20_000; // past the launch root's 10 s cap: no live root, no span keys
    for (const ms of [10, 20, 30, 40, 100]) await callFor(cap, 'Camera', 'getPhoto', ms);
    await callFor(cap, 'Camera', 'getPhoto', 5, false, Object.assign(new Error('User cancelled photos app'), { code: 'CANCELLED' }));
    await callFor(cap, 'Camera', 'getPhoto', 5, false, new TypeError('boom'));
    await callFor(cap, 'Preferences', 'get', 2);

    const out = await handOff();
    expect(out.map((r) => r.attributes)).toEqual([
      {
        'screen.name': '/camera',
        'bridge.service': 'Camera',
        'bridge.action': 'getPhoto',
        'bridge.count': 7,
        'bridge.error_count': 2,
        'bridge.p50_ms': 20,
        'bridge.p95_ms': 100,
        'bridge.max_ms': 100,
        'bridge.error_codes': 'CANCELLED,TypeError',
      },
      {
        'screen.name': '/camera',
        'bridge.service': 'Preferences',
        'bridge.action': 'get',
        'bridge.count': 1,
        'bridge.error_count': 0,
        'bridge.p50_ms': 2,
        'bridge.p95_ms': 2,
        'bridge.max_ms': 2,
      },
    ]);
  });

  it('never carries options, results or error messages (P5)', async () => {
    const { cap } = await load();
    await callFor(cap, 'Filesystem', 'readFile', 3, true, { data: 'the file body' });
    await callFor(cap, 'Filesystem', 'readFile', 3, false, Object.assign(new Error('/secret/file.txt not found'), { code: 'OS-PLUG-FILE-0008' }));
    const json = JSON.stringify(await handOff());
    expect(json).not.toMatch(/secret|file body|not found/);
    expect(json).toContain('OS-PLUG-FILE-0008');
  });

  it('excludes the SDK’s own plugin and leaves the caller’s promise untouched', async () => {
    const { cap } = await load();
    const p = cap.nativePromise('EdgeRum', 'enqueue', {});
    pending.shift()?.settle(true, 'ok');
    await expect(p).resolves.toBe('ok');
    const q = cap.nativePromise('Camera', 'getPhoto');
    pending.shift()?.settle(false, new Error('denied'));
    await expect(q).rejects.toThrow('denied');
    const out = await handOff();
    expect(out.map((r) => r.attributes['bridge.service'])).toEqual(['Camera']);
  });

  it('closes the window on a screen change', async () => {
    const { cap, core } = await load();
    core.__setCurrentRoute('/a');
    await callFor(cap, 'Camera', 'getPhoto', 5);
    core.__setCurrentRoute('/b');
    await callFor(cap, 'Camera', 'getPhoto', 7);
    const out = await handOff();
    expect(out.map((r) => [r.attributes['screen.name'], r.attributes['bridge.max_ms']])).toEqual([['/a', 5], ['/b', 7]]);
  });

  it('a call under a live root is a Tier-1 child span of it (X6, X8)', async () => {
    const { cap } = await load();
    now = 100; // inside the launch root
    await callFor(cap, 'Camera', 'getPhoto', 30);
    await callFor(cap, 'Camera', 'getPhoto', 10);
    const [row] = await handOff();
    const a = row!.attributes;
    expect(a['trace.root_type']).toBe('launch');
    expect(a['trace.id']).toMatch(/^[0-9a-f]{32}$/);
    expect(a['span.id']).toMatch(/^[0-9a-f]{16}$/);
    expect(a['parent.span.id']).toBe(a['rum.action.id']);
    expect(a['span.start_time']).toEqual(expect.any(String));
    expect(a['span.duration_ms']).toBe(40); // first start → last end
    expect(a['bridge.count']).toBe(2);
  });
});

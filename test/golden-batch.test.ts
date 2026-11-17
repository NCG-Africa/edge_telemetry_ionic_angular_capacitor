// @vitest-environment happy-dom
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// #149 / processor #40: every JS-captured event, recorded through the real SDK (fake native bridge),
// wrapped the way the native sender wraps it, and kept as a golden batch in `test/golden/`.
// `scripts/conform.sh` checks these plus the native goldens against the processor's event
// catalogue. `UPDATE_GOLDEN=1 pnpm vitest run test/golden-batch.test.ts` rewrites them.

type Row = { type: string; eventName?: string; metricName?: string; value?: number; timestamp: string; attributes: Record<string, unknown> };

const ROOT = process.cwd(); // vitest runs from the repo root
const DIR = join(ROOT, 'test/golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** Every name JS sends, canonical per the catalogue. */
const JS_EVENTS = [
  'app.crash', 'app.error', 'bridge.summary', 'custom.event', 'custom.metric', 'frame.summary', 'http.request',
  'navigation', 'perf.cls', 'perf.fcp', 'perf.inp', 'perf.lcp', 'perf.long_task', 'perf.resource_timing',
  'perf.ttfb', 'screen.duration', 'task.complete', 'ui.interaction',
];

const vitals = vi.hoisted(() => ({}) as Record<string, (m: object) => void>);
vi.mock('../packages/core/node_modules/web-vitals', () => Object.fromEntries(
  ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'].map((n) => [`on${n}`, (cb: (m: object) => void) => (vitals[n] = cb)]),
));

const g = globalThis as Record<string, unknown>;
let rows: Row[] = [];
const raf: ((ts: number) => void)[] = [];
const observers: { type?: string; cb: (list: { getEntries: () => object[] }) => void }[] = [];

function fakePlatform() {
  const plugin = new Proxy({}, {
    get: (_, m) => (arg: { events?: Row[] }) => {
      if (m === 'getState') return Promise.resolve({ enabled: true, sessionId: 'session_1' });
      if (m === 'enqueue') rows.push(...(arg.events ?? []));
      return Promise.resolve({});
    },
  });
  const nativePromise = () => Promise.resolve({});
  g.Capacitor = { isNativePlatform: () => true, registerPlugin: () => plugin, nativePromise };
  g.requestAnimationFrame = (cb: (ts: number) => void) => raf.push(cb);
  g.cancelAnimationFrame = () => {};
  class FakeObserver {
    static supportedEntryTypes = ['longtask', 'resource'];
    private entry: (typeof observers)[number];
    constructor(cb: (typeof observers)[number]['cb']) {
      this.entry = { cb };
      observers.push(this.entry);
    }
    observe(o: { type?: string }) {
      this.entry.type = o.type;
    }
    disconnect() {}
  }
  g.PerformanceObserver = FakeObserver;
  (window as unknown as Record<string, unknown>).fetch = async () => new Response('{}', { status: 200, headers: { 'content-length': '2' } });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function handOff(): Promise<Row[]> {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  await tick();
  const out = rows;
  rows = [];
  return out;
}

// Values that differ run to run, replaced by fixed ones of the same JSON type (int stays int).
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HEX = /^[0-9a-f]{16}([0-9a-f]{16})?$/;
const VOLATILE_NUMBER = /(duration|_ms$)/;

function normalise(key: string, v: unknown): unknown {
  if (typeof v === 'string') {
    if (ISO.test(v)) return '2026-10-26T10:00:00.000Z';
    if (HEX.test(v)) return v.length === 32 ? '4bf92f3577b34da6a3ce929d0e0e4736' : '00f067aa0ba902b7';
    if (key === 'error.stacktrace') return 'Error: boom\n    at app:///main.js:1:1';
    if (key === 'error.breadcrumbs') return '[]';
  }
  if (typeof v === 'number' && VOLATILE_NUMBER.test(key)) return Number.isInteger(v) ? 16 : 16.5;
  return v;
}

/** What native stamps on every row at append (E32), as on an Android device. */
const STAMP = {
  'session.id': 'session_1700000000000_0123456789abcdef_android',
  'user.id': 'u1',
  'device.platform': 'android',
  'device.platform_version': '15',
  'device.model': 'Pixel 8',
  'device.manufacturer': 'Google',
  'device.android_sdk': 35,
  'device.locale': 'en-KE',
  'webview.version': '131.0.6778.135',
  'app.bundle_id': 'builtin',
  'network.type': 'wifi',
};

/** The batch native would send for one JS row: the T2 envelope plus native's per-row stamp. */
function batch(row: Row) {
  const attributes = Object.fromEntries(
    Object.entries({ ...STAMP, ...row.attributes }).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalise(k, v)]),
  );
  const event = { ...row, timestamp: '2026-10-26T10:00:00.000Z', attributes };
  return {
    type: 'telemetry_batch',
    contract_version: CONTRACT_VERSION,
    timestamp: '2026-10-26T10:00:01.000Z',
    batch_size: 1,
    device_id: 'device_1700000000000_0123456789abcdef_android',
    sdk: { name: 'ionic', version: SDK_VERSION },
    app: { name: 'Fixture', package_name: 'com.nathanclaire.rum.fixture', platform: 'android', version: '1.4.2', build_number: '142' },
    events: [event],
  };
}

let SDK_VERSION = '';
let CONTRACT_VERSION = '';
const recorded = new Map<string, Row>();

beforeAll(async () => {
  fakePlatform();
  const core = await import('@nathanclaire/rum');
  const { bridge } = await import('@nathanclaire/rum-capacitor');
  SDK_VERSION = core.SDK_VERSION;
  CONTRACT_VERSION = readFileSync(join(ROOT, 'packages/capacitor/ios/Plugin/Core/Sender.swift'), 'utf8').match(/contractVersion = "([^"]+)"/)?.[1] ?? '';
  const { EdgeRum } = core;

  EdgeRum.init({ captures: [...core.defaultCaptures(), core.resourceTiming(), bridge()], release: 'app@1.4.2' });
  await tick();

  EdgeRum.trackScreen('/home');
  EdgeRum.trackScreen('/products/:id'); // navigation, and screen.duration for /home
  EdgeRum.track('cart.opened');
  EdgeRum.measure('cart.total', 42.5);
  EdgeRum.startTask('checkout');
  EdgeRum.completeTask('checkout');
  EdgeRum.captureError(new TypeError('handled boom'));
  window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom'), message: 'boom' }));
  await fetch('https://api.example.com/v2/users/42');
  document.body.innerHTML = '<button id="buy">Buy now</button>';
  document.getElementById('buy')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await (g.Capacitor as { nativePromise: (p: string, m: string) => Promise<unknown> }).nativePromise('Camera', 'getPhoto');
  for (const [name, value] of [['LCP', 812.5], ['INP', 96], ['CLS', 0.05], ['FCP', 410], ['TTFB', 120]] as const) {
    vitals[name]!({ name, value, rating: 'good', delta: value, id: 'v1', entries: [], navigationType: 'navigate' });
  }
  for (const o of observers) {
    o.cb({
      getEntries: () => [o.type === 'longtask'
        ? { name: 'self', duration: 120, entryType: 'longtask' }
        : { name: 'https://cdn.example.com/a.js', duration: 80, initiatorType: 'script', transferSize: 2048 }],
    });
  }
  // Three frames, one slow: the window closes on the next screen change.
  for (const ts of [0, 16, 60, 76]) raf.splice(0).forEach((f) => f(ts));
  await new Promise((r) => setTimeout(r, 1100)); // the tap's dead-tap window
  EdgeRum.trackScreen('/cart');
  for (const row of await handOff()) recorded.set(row.eventName ?? row.metricName ?? '', row);
});

afterAll(() => {
  delete g.Capacitor;
});

describe('golden batches (#149)', () => {
  it('JS sends exactly the catalogue names', () => {
    expect([...recorded.keys()].sort()).toEqual(JS_EVENTS);
  });

  it.each(JS_EVENTS)('%s matches its golden', (name) => {
    const row = recorded.get(name);
    expect(row).toBeDefined();
    const file = join(DIR, `${name.replace(/\./g, '-')}.json`);
    const got = `${JSON.stringify(batch(row!), null, 2)}\n`;
    if (UPDATE) {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(file, got);
    }
    expect(got).toBe(readFileSync(file, 'utf8'));
  });
});

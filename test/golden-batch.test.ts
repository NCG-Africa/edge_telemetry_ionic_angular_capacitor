// @vitest-environment happy-dom
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// #149, spec 2026-11-23 stable goldens: every JS-captured event, recorded through the real SDK (fake
// native bridge), dumped as handed to `enqueue` to the gitignored `test/golden-raw/js-rows.json`.
// The Android core test `JsGoldenTest` stamps and sends them through the real native sender into
// `test/golden-raw/js`; `scripts/conform.sh` runs both, then checks the shape.

type Row = { type: string; eventName?: string; metricName?: string; value?: number; timestamp: string; attributes: Record<string, unknown> };

const ROOT = process.cwd(); // vitest runs from the repo root
const RAW = join(ROOT, 'test/golden-raw');

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

const recorded = new Map<string, Row>();

beforeAll(async () => {
  fakePlatform();
  const core = await import('@nathanclaire/rum');
  const { bridge } = await import('@nathanclaire/rum-capacitor');
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
  document.getElementById('buy')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await (g.Capacitor as { nativePromise: (p: string, m: string) => Promise<unknown> }).nativePromise('Camera', 'getPhoto');
  for (const [name, value] of [['LCP', 812.5], ['INP', 96], ['CLS', 0.05], ['FCP', 410], ['TTFB', 120]] as const) {
    vitals[name]?.({ name, value, rating: 'good', delta: value, id: 'v1', entries: [], navigationType: 'navigate' });
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

describe('golden batches (#149, stable goldens)', () => {
  it('JS sends exactly the catalogue names', () => {
    expect([...recorded.keys()].sort()).toEqual(JS_EVENTS);
  });

  it('dumps the rows for the native sender', () => {
    mkdirSync(RAW, { recursive: true });
    writeFileSync(join(RAW, 'js-rows.json'), `${JSON.stringify([...recorded.values()], null, 2)}\n`);
  });
});

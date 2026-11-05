import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Spec Q1: pins the A2 plugin-method table against the fake Capacitor bridge, end to end
// through mock-ingest.
const INGEST = 'http://localhost:4319';

interface NativeCall { method: string; arg: unknown }
interface Row { eventName?: string; metricName?: string; attributes: Record<string, unknown> }
type Rum = typeof import('../../packages/core/dist/index.mjs') & typeof import('../../packages/capacitor/dist/index.mjs');

declare global {
  interface Window {
    Rum: Rum;
    __calls: NativeCall[];
    __rotate: (sessionId: string) => void;
  }
}

const calls = (page: Page) => page.evaluate(() => window.__calls);
const ingested = async (request: APIRequestContext): Promise<Row[]> => {
  const { payloads } = (await (await request.get(`${INGEST}/__payloads`)).json()) as { payloads: { events: Row[] }[] };
  return payloads.flatMap((p) => p.events);
};

test.beforeEach(async ({ page, request }) => {
  await request.post(`${INGEST}/__reset`);
  await page.goto('/');
});

test('A2 plugin methods and args', async ({ page }) => {
  await page.evaluate(() => {
    const { EdgeRum } = window.Rum;
    // Before init: held until native state is known (A4).
    EdgeRum.identify({ id: 'u1', email: 'a@b.c' });
    EdgeRum.track('checkout', { plan: 'pro' });
    EdgeRum.init({ apiKey: 'edge_k', endpoint: 'https://ingest.example', captures: [] });
    EdgeRum.markReady();
  });
  await expect.poll(async () => (await calls(page)).some((c) => c.method === 'enqueue')).toBe(true);
  await page.evaluate(() => {
    const { EdgeRum } = window.Rum;
    EdgeRum.trackScreen('/tabs/home');
    EdgeRum.clearUser();
    EdgeRum.disable();
    EdgeRum.enable();
    EdgeRum.reset();
  });

  expect(await calls(page)).toEqual([
    { method: 'addListener', arg: 'state' },
    { method: 'getState', arg: undefined },
    { method: 'identify', arg: { id: 'u1', email: 'a@b.c' } },
    { method: 'configure', arg: { apiKey: 'edge_k', endpoint: 'https://ingest.example' } },
    { method: 'markPhase', arg: { phase: 'markReady', ts: expect.any(Number) } },
    { method: 'markPhase', arg: { phase: 'bridgeReady', ts: expect.any(Number) } },
    // A3: new crumbs ride every hand-off.
    { method: 'enqueue', arg: {
      events: [expect.objectContaining({ eventName: 'custom_event' })],
      breadcrumbs: [{ ts: expect.any(String), type: 'custom_event', name: 'checkout' }],
    } },
    { method: 'setLastScreen', arg: { screen: '/tabs/home' } },
    { method: 'clearUser', arg: undefined },
    { method: 'disable', arg: undefined },
    { method: 'enable', arg: undefined },
    { method: 'reset', arg: undefined },
  ]);
});

test('a custom event reaches mock-ingest with global attributes, after beforeSend', async ({ page, request }) => {
  await page.evaluate(() => {
    const { EdgeRum } = window.Rum;
    EdgeRum.init({
      captures: [],
      beforeSend: (e) => (e.attributes['event.name'] === 'secret' ? null : e),
    });
    EdgeRum.setAttribute('tenant', 'acme');
    EdgeRum.track('secret');
    EdgeRum.track('checkout', { plan: 'pro' });
  });
  // T1: the 2 s hand-off timer, then the fake sender's POST.
  await expect.poll(async () => (await ingested(request)).filter((e) => e.eventName === 'custom_event'), { timeout: 10_000 })
    .toEqual([expect.objectContaining({
      attributes: expect.objectContaining({ 'event.name': 'checkout', plan: 'pro', tenant: 'acme', 'session.id': 'harness-session' }),
    })]);
  const enqueue = (await calls(page)).find((c) => c.method === 'enqueue');
  expect(enqueue?.arg).toMatchObject({ drops: { before_send_null: 1 } });
});

test('a thrown error reaches mock-ingest at once as app.crash', async ({ page, request }) => {
  await page.evaluate(() => {
    window.Rum.EdgeRum.init({ captures: [] });
    setTimeout(() => {
      throw new TypeError('harness boom');
    }, 50);
  });
  await expect.poll(async () => (await ingested(request)).find((e) => e.eventName === 'app.crash'), { timeout: 1_500 })
    .toMatchObject({ attributes: { exception_type: 'TypeError', message: expect.stringContaining('harness boom'), runtime: 'webview' } });
});

test('fetch and XHR reach mock-ingest as http.request with templated URLs (E6, P2)', async ({ page, request }) => {
  await page.evaluate(async () => {
    window.Rum.EdgeRum.init({ captures: [] });
    await fetch('/harness.html?token=secret');
    // XHR is what Angular HttpClient uses by default.
    await new Promise((done) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/missing/v2/12345');
      xhr.addEventListener('loadend', done);
      xhr.send('{"a":1}');
    });
  });
  const origin = new URL(page.url()).origin;
  await expect.poll(async () => (await ingested(request)).filter((e) => e.eventName === 'http.request').map((e) => e.attributes), { timeout: 10_000 })
    .toEqual([
      expect.objectContaining({ 'http.url': `${origin}/harness.html`, 'http.method': 'GET', 'http.status_code': 200, 'http.success': true }),
      expect.objectContaining({ 'http.url': `${origin}/missing/v2/{id}`, 'http.method': 'POST', 'http.success': false, 'http.request_size': 7 }),
    ]);
});

test('session rotation abandons open tasks', async ({ page, request }) => {
  await page.evaluate(async () => {
    const { EdgeRum } = window.Rum;
    EdgeRum.init({ captures: [] });
    await EdgeRum.getSessionId();
    EdgeRum.startTask('checkout');
    window.__rotate('next-session');
  });
  expect(await page.evaluate(() => window.Rum.EdgeRum.getSessionId())).toBe('next-session');
  await expect.poll(async () => (await ingested(request)).find((e) => e.eventName === 'task.complete'), { timeout: 10_000 })
    .toMatchObject({ attributes: { 'task.name': 'checkout', 'task.outcome': 'abandoned', 'task.abandon_source': 'session_end' } });
});

test('web is a silent no-op (A7)', async ({ page }) => {
  await page.goto('/harness.html');
  const result = await page.evaluate(async () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = undefined;
    // A fresh copy of the SDK that never saw the bridge.
    const src = await (await fetch('/dist/harness.js')).text();
    const fresh = new Function(`${src}; return Rum;`)() as Rum;
    fresh.EdgeRum.init();
    fresh.EdgeRum.track('x');
    return fresh.EdgeRum.getSessionId();
  });
  expect(result).toBe('');
  expect((await calls(page)).length).toBe(0);
});

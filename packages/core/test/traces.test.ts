import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTraceparent } from '../src/traces';

// Spec X1–X10 through the public API and the fake bridge (Q1). Header shape pinned to Android's
// `TraceManagerTest.kt` fixtures (`headerRegex`, inbound adopt / overwrite cases).
type Attrs = Record<string, unknown>;
const HEADER = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const A = 'a'.repeat(32);
const B = 'b'.repeat(16);

let calls: [string, unknown][];
let ready: (s?: object) => void;
let stateListener: (s: object) => void;
let appListener: (s: { isActive: boolean }) => void;
let sent: { url: string; headers: Headers }[];
let clock: number;

function setup() {
  calls = [];
  sent = [];
  let release: (s: object) => void = () => {};
  const gate = new Promise<object>((r) => (release = r));
  ready = (s = { enabled: true, sessionId: 's1', sampled: true }) => release(s);
  const plugin: Record<string, (...a: unknown[]) => Promise<unknown>> = {
    getState: () => gate,
    addListener: (_e, cb) => {
      stateListener = cb as typeof stateListener;
      return Promise.resolve({ remove: () => {} });
    },
  };
  for (const m of ['enqueue', 'configure', 'markPhase', 'setLastScreen', 'setRoot']) {
    plugin[m] = (arg) => {
      calls.push([m, arg]);
      return Promise.resolve();
    };
  }
  (globalThis as Attrs).Capacitor = {
    isNativePlatform: () => true,
    registerPlugin: () => plugin,
    Plugins: { App: { addListener: (_e: string, cb: typeof appListener) => ((appListener = cb), Promise.resolve()) } },
  };
  (globalThis as Attrs).document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  (globalThis as Attrs).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : undefined;
    sent.push({ url: req ? req.url : String(input), headers: new Headers(init?.headers ?? req?.headers) });
    return new Response('', { status: 200 });
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function load() {
  vi.resetModules();
  return (await import('../src/index')).EdgeRum;
}

/** Everything handed to native, as flat rows. */
async function rows(): Promise<{ eventName?: string; metricName?: string; attributes: Attrs }[]> {
  await tick();
  const { flush } = await import('../src/core');
  flush();
  await tick();
  return calls.filter(([m]) => m === 'enqueue').flatMap(([, a]) => (a as { events: never[] }).events);
}
const http = async () => (await rows()).filter((e) => e.eventName === 'http.request').map((e) => e.attributes);
const roots = () => calls.filter(([m]) => m === 'setRoot').map(([, a]) => a as Attrs);

beforeEach(() => {
  setup();
  clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ['Capacitor', 'document', 'fetch']) delete (globalThis as Attrs)[k];
});

describe('roots and Tier-2 (X2, X8, X10)', () => {
  it('mints the launch root at init, relays it once, and annotates crash / custom_event / screen.duration only', async () => {
    const EdgeRum = await load();
    EdgeRum.init();
    ready();
    EdgeRum.track('checkout');
    EdgeRum.captureError(new Error('x'));
    EdgeRum.measure('cart.items', 3);
    const all = await rows();
    const [launch] = roots();
    expect(roots()).toHaveLength(1);
    expect(launch).toEqual({ 'trace.id': expect.stringMatching(/^[0-9a-f]{32}$/), 'rum.action.id': expect.stringMatching(/^[0-9a-f]{16}$/), 'trace.root_type': 'launch' });
    expect(all.find((e) => e.eventName === 'custom_event')?.attributes).toMatchObject(launch as object);
    expect(all.find((e) => e.eventName === 'app.crash')?.attributes).toMatchObject(launch as object);
    expect(all.find((e) => e.metricName === 'cart.items')?.attributes).not.toHaveProperty('trace.id');
  });

  it('a click mints an interaction root with Tier-1 keys; the request it fires is its child', async () => {
    const EdgeRum = await load();
    const { interactions } = await import('../src/index');
    EdgeRum.init({ captures: [interactions()], traceHostAllowlist: ['api.example.com'] });
    ready();
    await tick();
    const button = Object.assign(new EventTarget(), { tagName: 'button', id: 'buy' });
    const click = new Event('click');
    Object.defineProperty(click, 'target', { value: button });
    (globalThis as unknown as { document: EventTarget }).document.dispatchEvent(click);
    await fetch('https://api.example.com/orders');
    const all = await rows();
    const tap = all.find((e) => e.eventName === 'user.interaction')?.attributes as Attrs;
    expect(tap).toMatchObject({ 'trace.root_type': 'interaction', 'span.start_time': expect.stringMatching(ISO) });
    expect(tap['span.id']).toBe(tap['rum.action.id']);
    expect(tap).not.toHaveProperty('parent.span.id');
    expect(roots().at(-1)).toMatchObject({ 'trace.id': tap['trace.id'], 'trace.root_type': 'interaction' });
    const [req] = await http();
    expect(req).toMatchObject({ 'trace.id': tap['trace.id'], 'parent.span.id': tap['span.id'], 'rum.action.id': tap['span.id'], 'traceparent.outcome': 'injected_attributed' });
  });

  it('background clears the root (later requests are injected_expired); resume mints a resume root (X9)', async () => {
    const EdgeRum = await load();
    EdgeRum.init({ traceHostAllowlist: ['api.example.com'] });
    ready();
    await tick();
    appListener({ isActive: false });
    await tick();
    expect(roots().at(-1)).toEqual({});
    await fetch('https://api.example.com/a');
    appListener({ isActive: true });
    await tick();
    expect(roots().at(-1)).toMatchObject({ 'trace.root_type': 'resume' });
    await fetch('https://api.example.com/b');
    const [a, b] = await http();
    expect(a).toMatchObject({ 'traceparent.outcome': 'injected_expired', 'trace.root_type': 'request' });
    expect(b).toMatchObject({ 'traceparent.outcome': 'injected_attributed', 'trace.root_type': 'resume' });
  });

  it('session rotation clears the root', async () => {
    const EdgeRum = await load();
    EdgeRum.init();
    ready();
    await tick();
    stateListener({ enabled: true, sessionId: 's2' });
    await tick();
    expect(roots().at(-1)).toEqual({});
  });
});

describe('traceparent injection and outcomes (X3–X7)', () => {
  async function started(allowlist: string[] = ['api.example.com'], getState?: object) {
    const EdgeRum = await load();
    EdgeRum.init({ traceHostAllowlist: allowlist });
    ready(getState);
    await tick();
  }

  it('pins the dotted wire keys and header parity: span.id = header parent-id, child of launch', async () => {
    await started();
    await fetch('https://api.example.com/v1/orders/123?q=1');
    const [req] = await http();
    const header = sent[0]?.headers.get('traceparent');
    expect(header).toMatch(HEADER);
    expect(header).toBe(`00-${req?.['trace.id']}-${req?.['span.id']}-01`);
    expect(req).toMatchObject({
      'trace.root_type': 'launch',
      'traceparent.outcome': 'injected_attributed',
      'span.start_time': expect.stringMatching(ISO),
      'span.duration_ms': expect.any(Number),
      'parent.span.id': roots()[0]?.['rum.action.id'],
    });
    for (const v of Object.values(req ?? {})) expect(['string', 'number', 'boolean']).toContain(typeof v);
    expect(JSON.stringify(req)).not.toMatch(/traceId|spanId|resourceSpans|opentelemetry/);
  });

  it('off-allowlist: ids stamped, no header', async () => {
    await started();
    await fetch('https://other.example.org/x');
    expect(sent[0]?.headers.has('traceparent')).toBe(false);
    expect((await http())[0]).toMatchObject({ 'traceparent.outcome': 'skipped_off_allowlist', 'trace.id': expect.any(String), 'span.id': expect.any(String) });
  });

  it('empty allowlist (default) injects nowhere; with no live root a skip mints nothing', async () => {
    await started([]);
    clock += 10_001;
    await fetch('https://api.example.com/x');
    expect(sent[0]?.headers.has('traceparent')).toBe(false);
    const [req] = await http();
    expect(req).toMatchObject({ 'traceparent.outcome': 'skipped_off_allowlist', 'trace.id': expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(req).not.toHaveProperty('rum.action.id');
    expect(roots().map((r) => r['trace.root_type'])).toEqual(['launch']);
  });

  it('no-cors: skipped_no_cors, no header', async () => {
    await started();
    await fetch('https://api.example.com/x', { mode: 'no-cors' });
    expect(sent[0]?.headers.has('traceparent')).toBe(false);
    expect((await http())[0]?.['traceparent.outcome']).toBe('skipped_no_cors');
  });

  it('before getState: skipped_no_session, no header; the row still has ids (A4)', async () => {
    const EdgeRum = await load();
    EdgeRum.init({ traceHostAllowlist: ['api.example.com'] });
    await fetch('https://api.example.com/x');
    expect(sent[0]?.headers.has('traceparent')).toBe(false);
    ready();
    expect((await http())[0]).toMatchObject({ 'traceparent.outcome': 'skipped_no_session', 'trace.id': expect.any(String), 'span.id': expect.any(String) });
  });

  it('sampled-out session: no header and no trace keys (X5)', async () => {
    await started(['api.example.com'], { enabled: true, sessionId: 's1', sampled: false });
    await fetch('https://api.example.com/x');
    expect(sent[0]?.headers.has('traceparent')).toBe(false);
    expect((await http())[0]).not.toHaveProperty('trace.id');
  });

  it('a valid consumer header is adopted: mirrored, untouched, rum.action.id stays local', async () => {
    await started();
    const theirs = `00-${A}-${B}-01`;
    const headers = new Headers({ traceparent: theirs });
    await fetch(new Request('https://api.example.com/x', { headers }));
    expect(sent[0]?.headers.get('traceparent')).toBe(theirs);
    expect(headers.get('traceparent')).toBe(theirs);
    const [req] = await http();
    expect(req).toMatchObject({ 'trace.id': A, 'span.id': B, 'traceparent.outcome': 'adopted', 'rum.action.id': roots()[0]?.['rum.action.id'] });
    expect(req).not.toHaveProperty('parent.span.id');
  });

  it('a malformed consumer header is overwritten, on a copy', async () => {
    await started();
    const init = { headers: { traceparent: '00-tooshort-b-01' } };
    await fetch('https://api.example.com/x', init);
    expect(sent[0]?.headers.get('traceparent')).toMatch(HEADER);
    expect(init.headers.traceparent).toBe('00-tooshort-b-01');
    expect((await http())[0]?.['traceparent.outcome']).toBe('injected_attributed');
  });

  it('expiry: past the cap a request mints a request root (injected_expired); the next joins it (X1)', async () => {
    await started();
    clock += 10_001;
    await fetch('https://api.example.com/a');
    clock += 1500;
    await fetch('https://api.example.com/b');
    clock += 2001;
    await fetch('https://api.example.com/c');
    const [a, b, c] = await http();
    expect(a).toMatchObject({ 'traceparent.outcome': 'injected_expired', 'trace.root_type': 'request' });
    expect(a?.['span.id']).toBe(a?.['rum.action.id']);
    expect(a).not.toHaveProperty('span.duration_ms');
    expect(b).toMatchObject({ 'traceparent.outcome': 'injected_attributed', 'parent.span.id': a?.['span.id'] });
    // b's completion extended a's idle clock to 1500 ms after a; 2001 ms later it has expired.
    expect(c).toMatchObject({ 'traceparent.outcome': 'injected_expired' });
    expect(roots().map((r) => r['trace.root_type'])).toEqual(['launch', 'request', 'request']);
  });

  it('XHR: the consumer header is held to send; a malformed one is replaced, a valid one adopted', async () => {
    const set: [string, string][][] = [];
    class FakeXhr extends EventTarget {
      h: [string, string][] = [];
      status = 200;
      open() {
        set.push((this.h = []));
      }
      setRequestHeader(n: string, v: string) {
        this.h.push([n, v]);
      }
      send() {}
      getResponseHeader() {
        return null;
      }
    }
    (globalThis as Attrs).XMLHttpRequest = FakeXhr;
    try {
      await started();
      for (const tp of ['bad', `00-${A}-${B}-01`]) {
        const x = new XMLHttpRequest();
        x.open('GET', 'https://api.example.com/x');
        x.setRequestHeader('Traceparent', tp);
        x.setRequestHeader('accept', 'json');
        x.send();
        x.dispatchEvent(new Event('loadend'));
      }
      expect(set[0]).toEqual([['accept', 'json'], ['traceparent', expect.stringMatching(HEADER)]]);
      expect(set[1]).toEqual([['accept', 'json'], ['traceparent', `00-${A}-${B}-01`]]);
      expect((await http()).map((r) => r['traceparent.outcome'])).toEqual(['injected_attributed', 'adopted']);
    } finally {
      delete (globalThis as Attrs).XMLHttpRequest;
    }
  });

  it('allowlist: exact or dot-anchored suffix, ports ignored, no substring, .com rejected (X4)', async () => {
    await started(['API.example.com', '.corp.io', '.com', 'https://x.io', 'evil']);
    const urls = [
      'https://api.example.com:8443/a', // exact, port ignored
      'https://a.b.corp.io/a', // suffix
      'https://corp.io/a', // suffix needs a subdomain
      'https://notcorp.io/a', // no substring
      'https://api.example.com.evil.com/a',
      'https://x.io/a', // a scheme entry is dropped
      'https://evil/a', // single-label exact is allowed, as on Android
    ];
    for (const u of urls) await fetch(u);
    expect(sent.map((s) => s.headers.has('traceparent'))).toEqual([true, true, false, false, false, false, true]);
  });
});

describe('parseTraceparent (Android fixtures)', () => {
  it.each([
    [`00-${A}-${B}-01`, [A, B]],
    [`00-${A.toUpperCase()}-${B.toUpperCase()}-01`, [A, B]],
    [`00-${A}-${B}-01-extra`, [A, B]],
    [`ff-${A}-${B}-01`, undefined],
    [`00-${'0'.repeat(32)}-${B}-01`, undefined],
    [`00-${A}-${'0'.repeat(16)}-01`, undefined],
    ['00-tooshort-b-01', undefined],
    [`00-${A}-${B}`, undefined],
    [undefined, undefined],
  ])('%s', (v, want) => {
    expect(parseTraceparent(v)).toEqual(want);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spec Q1: the fake Capacitor bridge stands in for the native `EdgeRum` plugin (A2 table).
type Call = [method: string, arg: unknown];
interface Fake {
  calls: Call[];
  ready: (s?: object) => void;
  push: (s: object) => void;
  failEnqueue: boolean;
  enqueued: () => { events: { eventName?: string; metricName?: string; attributes: Record<string, unknown> }[]; breadcrumbs: { name: string }[]; drops?: Record<string, number> }[];
}

function fakeBridge(): Fake {
  const calls: Call[] = [];
  let release: (s: object) => void = () => {};
  const gate = new Promise<object>((r) => (release = r));
  let listener: (s: object) => void = () => {};
  const fake: Fake = {
    calls,
    ready: (s = { enabled: true, sessionId: 's1' }) => release(s),
    push: (s) => listener(s),
    failEnqueue: false,
    enqueued: () => calls.filter(([m]) => m === 'enqueue').map(([, a]) => a as ReturnType<Fake['enqueued']>[number]),
  };
  const plugin: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
  for (const m of ['enqueue', 'configure', 'identify', 'clearUser', 'enable', 'disable', 'reset', 'markPhase', 'setLastScreen', 'setRoot']) {
    plugin[m] = (arg) => {
      calls.push([m, arg]);
      return m === 'enqueue' && fake.failEnqueue ? Promise.reject(new Error('append failed')) : Promise.resolve();
    };
  }
  plugin.getState = () => {
    calls.push(['getState', undefined]);
    return gate;
  };
  plugin.addListener = (event, cb) => {
    calls.push(['addListener', event]);
    listener = cb as (s: object) => void;
    return Promise.resolve({ remove: () => {} });
  };
  (globalThis as Record<string, unknown>).Capacitor = { isNativePlatform: () => true, registerPlugin: () => plugin };
  return fake;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const doc = () => (globalThis as unknown as { document: EventTarget & { visibilityState: string } }).document;

async function load() {
  vi.resetModules();
  return (await import('../src/index')).EdgeRum;
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).Capacitor;
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).Zone;
});

describe('web (A7)', () => {
  it('every method is a silent no-op without a native platform', async () => {
    const EdgeRum = await load();
    expect(() => {
      EdgeRum.init({ apiKey: 'bad' });
      EdgeRum.track('x');
      EdgeRum.identify({ id: 'u' });
      EdgeRum.disable();
      EdgeRum.reset();
    }).not.toThrow();
    await expect(EdgeRum.getSessionId()).resolves.toBe('');
  });
});

describe('buffer and hand-off (A4, T1)', () => {
  it('buffers before getState, then hands everything off in one enqueue', async () => {
    const fake = fakeBridge();
    const EdgeRum = await load();
    EdgeRum.track('before-init');
    EdgeRum.init();
    EdgeRum.track('a');
    await tick();
    expect(fake.enqueued()).toHaveLength(0);
    fake.ready();
    await tick();
    const [batch] = fake.enqueued();
    expect(batch?.events.map((e) => e.attributes['event.name'])).toEqual(['before-init', 'a']);
    expect(fake.calls).toContainEqual(['markPhase', expect.objectContaining({ phase: 'bridgeReady' })]);
  });

  it('caps the pre-ready buffer at 500, drop-oldest, and reports the count', async () => {
    const fake = fakeBridge();
    const EdgeRum = await load();
    EdgeRum.init();
    for (let i = 0; i < 510; i++) EdgeRum.track(`e${i}`);
    fake.ready();
    await tick();
    const [batch] = fake.enqueued();
    expect(batch?.events).toHaveLength(500);
    expect(batch?.events[0]?.attributes['event.name']).toBe('e10');
    expect(batch?.drops).toEqual({ js_buffer_full: 10 });
  });

  it('hands off at 20 events, after 2 s, on hidden, and on a crash', async () => {
    const fake = fakeBridge();
    const EdgeRum = await load();
    EdgeRum.init();
    fake.ready();
    await tick();
    vi.useFakeTimers();

    for (let i = 0; i < 20; i++) EdgeRum.track('n');
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.enqueued()).toHaveLength(1);

    EdgeRum.track('timer');
    await vi.advanceTimersByTimeAsync(1999);
    expect(fake.enqueued()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.enqueued()).toHaveLength(2);

    EdgeRum.track('hidden');
    doc().visibilityState = 'hidden';
    doc().dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.enqueued()).toHaveLength(3);

    EdgeRum.captureError(new Error('boom'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.enqueued()).toHaveLength(4);
    expect(fake.enqueued()[3]?.events[0]?.eventName).toBe('app.crash');
  });

  it('counts a failed hand-off and resends the count next time', async () => {
    const fake = fakeBridge();
    const EdgeRum = await load();
    EdgeRum.init();
    fake.ready();
    await tick();
    fake.failEnqueue = true;
    EdgeRum.captureError(new Error('x'));
    await tick();
    fake.failEnqueue = false;
    EdgeRum.captureError(new Error('y'));
    await tick();
    expect(fake.enqueued()[1]?.drops).toEqual({ js_exec_failed: 1 });
  });
});

describe('beforeSend (P1)', () => {
  it('drops on null, drops on throw, counts both, and restores session keys', async () => {
    const fake = fakeBridge();
    const EdgeRum = await load();
    EdgeRum.init({
      beforeSend: (e) => {
        if (e.attributes['event.name'] === 'drop') return null;
        if (e.attributes['event.name'] === 'throw') throw new Error('host bug');
        delete e.attributes['session.id'];
        return { ...e, eventName: 'renamed', attributes: { ...e.attributes, scrubbed: true } };
      },
    });
    EdgeRum.track('drop');
    EdgeRum.track('throw');
    EdgeRum.track('keep', { 'session.id': 'sid' });
    fake.ready();
    await tick();
    const [batch] = fake.enqueued();
    expect(batch?.events).toHaveLength(1);
    expect(batch?.events[0]).toMatchObject({ eventName: 'custom_event', attributes: { 'session.id': 'sid', scrubbed: true } });
    expect(batch?.drops).toEqual({ before_send_null: 1, before_send_error: 1 });
  });
});

describe('API (C2, C5, C6)', () => {
  it('init fails open on a malformed key and passes runtime overrides to native', async () => {
    const fake = fakeBridge();
    const EdgeRum = await load();
    expect(() => EdgeRum.init({ apiKey: 'wrong', endpoint: 'https://in.example.com' })).not.toThrow();
    fake.ready();
    await tick();
    expect(fake.calls).toContainEqual(['configure', { apiKey: 'wrong', endpoint: 'https://in.example.com' }]);
  });

  it('starts each capture once; a throwing capture does not stop init', async () => {
    fakeBridge();
    const EdgeRum = await load();
    const start = vi.fn();
    EdgeRum.init({ captures: [{ name: 'bad', start: () => { throw new Error('x'); } }, { name: 'ok', start }] });
    expect(start).toHaveBeenCalledOnce();
  });

  it('getSessionId waits for native state and follows rotation', async () => {
    const fake = fakeBridge();
    const EdgeRum = await load();
    EdgeRum.init();
    const id = EdgeRum.getSessionId();
    fake.ready({ enabled: true, sessionId: 's1' });
    await expect(id).resolves.toBe('s1');
    fake.push({ type: 'session', enabled: true, sessionId: 's2' });
    await expect(EdgeRum.getSessionId()).resolves.toBe('s2');
  });

  it('tasks: completed / failed, and abandoned on session rotation (E29)', async () => {
    const fake = fakeBridge();
    const EdgeRum = await load();
    EdgeRum.init();
    fake.ready();
    await tick();
    EdgeRum.startTask('checkout', { cart: 3 });
    EdgeRum.completeTask('checkout');
    EdgeRum.startTask('pay');
    EdgeRum.failTask('pay', 'declined');
    EdgeRum.startTask('open');
    fake.push({ type: 'session', enabled: true, sessionId: 's2' });
    EdgeRum.completeTask('unknown');
    doc().visibilityState = 'hidden';
    doc().dispatchEvent(new Event('visibilitychange'));
    await tick();
    const rows = fake.enqueued().flatMap((b) => b.events).map((e) => e.attributes);
    expect(rows).toEqual([
      expect.objectContaining({ 'task.name': 'checkout', 'task.outcome': 'completed', cart: 3 }),
      expect.objectContaining({ 'task.name': 'pay', 'task.outcome': 'failed', 'task.failure_reason': 'declined' }),
      expect.objectContaining({ 'task.name': 'open', 'task.outcome': 'abandoned', 'task.abandon_source': 'session_end' }),
    ]);
  });

  it('setAttribute stamps JS events; measure/time emit numeric rows', async () => {
    const fake = fakeBridge();
    const EdgeRum = await load();
    EdgeRum.init();
    EdgeRum.setAttribute('tier', 'gold');
    EdgeRum.measure('cart.items', 3);
    EdgeRum.time('load').end();
    EdgeRum.removeAttribute('tier');
    EdgeRum.measure('nan', NaN);
    EdgeRum.track('plain');
    fake.ready();
    await tick();
    const events = fake.enqueued()[0]?.events ?? [];
    expect(events.map((e) => e.metricName ?? e.eventName)).toEqual(['cart.items', 'load', 'custom_event']);
    expect(events[0]?.attributes.tier).toBe('gold');
    expect(events[2]?.attributes.tier).toBeUndefined();
  });

  it('disable before native is ready wins over native state and clears the buffer (P7)', async () => {
    const fake = fakeBridge();
    const EdgeRum = await load();
    EdgeRum.init();
    EdgeRum.track('lost');
    EdgeRum.disable();
    fake.ready({ enabled: true, sessionId: 's1' });
    await tick();
    EdgeRum.track('ignored');
    await tick();
    expect(fake.enqueued()).toHaveLength(0);
    expect(fake.calls).toContainEqual(['disable', undefined]);
  });

  it('identify / clearUser / markReady / reset relay to native', async () => {
    const fake = fakeBridge();
    const EdgeRum = await load();
    EdgeRum.identify({ id: 'u1', email: 'a@b.c', extra: 1 } as never);
    EdgeRum.clearUser();
    EdgeRum.markReady();
    EdgeRum.reset();
    EdgeRum.init();
    fake.ready();
    await tick();
    const methods = fake.calls.map(([m]) => m);
    expect(methods).toEqual(expect.arrayContaining(['identify', 'clearUser', 'markPhase', 'reset']));
    expect(fake.calls).toContainEqual(['identify', { id: 'u1', email: 'a@b.c' }]);
  });
});

describe('errors (Y2, C6)', () => {
  it('captureError stamps release and keeps its own keys over host attrs', async () => {
    const fake = fakeBridge();
    const EdgeRum = await load();
    EdgeRum.init({ release: 'web@1.2.3' });
    EdgeRum.track('plain');
    EdgeRum.captureError(new Error('x'), { handled: false, runtime: 'native', screen: 'Home' });
    fake.ready();
    await tick();
    const [plain, crash] = fake.enqueued()[0]?.events ?? [];
    expect(plain?.attributes.release).toBeUndefined();
    expect(crash?.attributes).toMatchObject({ release: 'web@1.2.3', handled: true, runtime: 'webview', screen: 'Home' });
  });

  it('captureError is handled, non-fatal, normalised, with no release by default (E10, Y2, Y3)', async () => {
    const fake = fakeBridge();
    const EdgeRum = await load();
    EdgeRum.init();
    const err = new TypeError('x');
    err.stack = 'TypeError: x\n    at f (capacitor://localhost/main.js:1:2)';
    EdgeRum.captureError(err);
    EdgeRum.captureError('plain string');
    fake.ready();
    await tick();
    const [a, b] = fake.enqueued()[0]?.events ?? [];
    expect(a?.attributes).toMatchObject({
      exception_type: 'TypeError', message: 'x', stacktrace: 'TypeError: x\n    at f (app:///main.js:1:2)',
      handled: true, is_fatal: false, cause: 'ManualCapture',
    });
    expect(a?.attributes).not.toHaveProperty('release');
    expect(b?.attributes).toMatchObject({ exception_type: 'Error', message: 'plain string' });
  });

  it('JS app.crash carries the live root\'s Tier-2 keys; other events do not (X8)', async () => {
    const fake = fakeBridge();
    const EdgeRum = await load();
    const { state } = await import('../src/core');
    EdgeRum.init();
    state.root = { 'trace.id': 't'.repeat(32), 'rum.action.id': 'a'.repeat(16), 'trace.root_type': 'interaction' };
    EdgeRum.track('plain');
    EdgeRum.captureError(new Error('x'));
    fake.ready();
    await tick();
    const [plain, crash] = fake.enqueued()[0]?.events ?? [];
    expect(plain?.attributes).not.toHaveProperty('trace.id');
    expect(crash?.attributes).toMatchObject(state.root);
  });
});

describe('breadcrumbs (A3)', () => {
  it('ships new crumbs with each hand-off for the native mirror, and resends after a failure', async () => {
    const fake = fakeBridge();
    const EdgeRum = await load();
    EdgeRum.init();
    EdgeRum.track('Home');
    fake.ready();
    await tick();
    expect(fake.enqueued()[0]?.breadcrumbs.map((c) => c.name)).toEqual(['Home']);

    fake.failEnqueue = true;
    EdgeRum.track('Cart');
    EdgeRum.captureError(new Error('x'));
    await tick();
    fake.failEnqueue = false;
    EdgeRum.captureError(new Error('y'));
    await tick();
    expect(fake.enqueued()[1]?.breadcrumbs.map((c) => c.name)).toEqual(['Cart']);
    expect(fake.enqueued()[2]?.breadcrumbs.map((c) => c.name)).toEqual(['Cart']);
  });

  it('disable() forgets crumbs, so they never reach native', async () => {
    const fake = fakeBridge();
    const EdgeRum = await load();
    EdgeRum.init();
    EdgeRum.trackScreen('Secret');
    EdgeRum.disable();
    EdgeRum.enable();
    EdgeRum.captureError(new Error('x'));
    fake.ready();
    await tick();
    const [batch] = fake.enqueued();
    expect(batch?.breadcrumbs).toEqual([]);
    expect(batch?.events[0]?.attributes['crash.breadcrumb_count']).toBe(0);
  });
});

describe('zones (A8)', () => {
  it('SDK timers are scheduled in the root zone', async () => {
    const run = vi.fn((f: () => unknown) => f());
    (globalThis as Record<string, unknown>).Zone = { root: { run } };
    const fake = fakeBridge();
    const EdgeRum = await load();
    EdgeRum.init();
    fake.ready();
    await tick();
    run.mockClear();
    EdgeRum.track('x');
    expect(run).toHaveBeenCalledOnce();
  });
});

describe('captureError never throws (C5)', () => {
  it('swallows a host error whose getters throw', async () => {
    fakeBridge();
    const EdgeRum = await load();
    EdgeRum.init();
    const evil = { get message(): string { throw new Error('getter'); } };
    expect(() => EdgeRum.captureError(evil)).not.toThrow();
  });
});

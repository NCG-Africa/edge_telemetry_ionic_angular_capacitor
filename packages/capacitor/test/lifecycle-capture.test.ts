import { describe, expect, it, vi } from 'vitest';

import {
  startLifecycleCapture,
  type AppModuleLike,
  type AppPluginListenerHandleLike,
  type AppStateLike,
  type LifecycleAttributes,
  type LifecycleCaptureCallbacks,
  type LifecycleSessionManagerLike,
} from '../src/LifecycleCapture';

type Listener = (state: AppStateLike) => void;

interface FakeApp extends AppModuleLike {
  emit: (state: AppStateLike) => void;
  removed: boolean;
}

function fakeApp(): FakeApp {
  let listener: Listener | undefined;
  const handle: AppPluginListenerHandleLike = {
    remove: async () => {
      listener = undefined;
      (mod as FakeApp).removed = true;
    },
  };
  const mod: Partial<FakeApp> = {
    addListener: (_name, cb) => {
      listener = cb;
      return handle;
    },
    emit: (state) => {
      if (listener) listener(state);
    },
    removed: false,
  };
  return mod as FakeApp;
}

interface FakeSession extends LifecycleSessionManagerLike {
  lastActiveAt: number;
  startCount: number;
}

function makeSession(initialLastActiveAt = 0): FakeSession {
  const s: FakeSession = {
    lastActiveAt: initialLastActiveAt,
    startCount: 0,
    getLastActiveAt: () => s.lastActiveAt,
    setLastActiveAt: (ts: number) => {
      s.lastActiveAt = ts;
    },
    startNewSession: () => {
      s.startCount += 1;
    },
  };
  return s;
}

interface CallbackState extends LifecycleCaptureCallbacks {
  events: Array<{ name: string; attrs: LifecycleAttributes }>;
  flushCount: () => number;
  fakeSession: FakeSession;
}

function makeCallbacks(opts: {
  flush?: () => Promise<void> | void;
  initialLastActiveAt?: number;
} = {}): CallbackState {
  const events: Array<{ name: string; attrs: LifecycleAttributes }> = [];
  const fakeSession = makeSession(opts.initialLastActiveAt ?? 0);
  let flushCount = 0;
  const flush = opts.flush ?? (() => {
    flushCount += 1;
  });
  return {
    events,
    fakeSession,
    flushCount: () => flushCount,
    session: fakeSession,
    recordEvent: vi.fn((name, attrs) => {
      events.push({ name, attrs });
    }),
    flushPipeline: vi.fn(async () => {
      const result = flush();
      if (result && typeof (result as Promise<void>).then === 'function') {
        await result;
      }
      flushCount += 1;
    }),
  };
}

function nativeCap() {
  return { isNativePlatform: () => true };
}

function assertPrimitive(attrs: LifecycleAttributes): void {
  for (const v of Object.values(attrs)) {
    expect(['string', 'number', 'boolean']).toContain(typeof v);
  }
}

function assertNoOtelKeys(obj: unknown): void {
  const body = JSON.stringify(obj);
  expect(body).not.toContain('traceId');
  expect(body).not.toContain('spanId');
  expect(body).not.toContain('resourceSpans');
  expect(body).not.toContain('instrumentationScope');
  expect(body).not.toContain('opentelemetry');
}

describe('startLifecycleCapture', () => {
  it('records cold_start_ms on the first foreground only', async () => {
    const app = fakeApp();
    const cb = makeCallbacks();
    let nowVal = 1_000_000;
    await startLifecycleCapture(cb, {
      capacitor: nativeCap(),
      loadApp: async () => app,
      now: () => nowVal,
      moduleLoadTime: 999_500,
    });

    nowVal = 1_000_000;
    app.emit({ isActive: true });
    expect(cb.events).toHaveLength(1);
    expect(cb.events[0]!.name).toBe('app_lifecycle');
    expect(cb.events[0]!.attrs['lifecycle.event']).toBe('foreground');
    expect(cb.events[0]!.attrs['lifecycle.cold_start_ms']).toBe(500);
    assertPrimitive(cb.events[0]!.attrs);
    assertNoOtelKeys(cb.events[0]!.attrs);

    // background then second foreground
    nowVal = 1_001_000;
    app.emit({ isActive: false });
    nowVal = 1_002_000;
    app.emit({ isActive: true });

    const fg2 = cb.events.filter((e) => e.attrs['lifecycle.event'] === 'foreground');
    expect(fg2).toHaveLength(2);
    expect('lifecycle.cold_start_ms' in fg2[1]!.attrs).toBe(false);
  });

  it('records background event and calls flushPipeline', async () => {
    const app = fakeApp();
    const cb = makeCallbacks();
    let nowVal = 5_000;
    await startLifecycleCapture(cb, {
      capacitor: nativeCap(),
      loadApp: async () => app,
      now: () => nowVal,
      moduleLoadTime: 0,
      flushTimeoutMs: 50,
    });

    app.emit({ isActive: false });
    expect(cb.events.at(-1)!.attrs['lifecycle.event']).toBe('background');
    expect(cb.fakeSession.lastActiveAt).toBe(5_000);
    expect(cb.flushPipeline).toHaveBeenCalledTimes(1);
    assertPrimitive(cb.events.at(-1)!.attrs);
    assertNoOtelKeys(cb.events.at(-1)!.attrs);
  });

  it('starts a new session when foregrounding after >30 minutes idle', async () => {
    const app = fakeApp();
    const SESSION_TIMEOUT = 30 * 60 * 1000;
    const cb = makeCallbacks({ initialLastActiveAt: 1_000 });
    let nowVal = 1_000 + SESSION_TIMEOUT + 1;
    await startLifecycleCapture(cb, {
      capacitor: nativeCap(),
      loadApp: async () => app,
      now: () => nowVal,
      moduleLoadTime: 0,
    });

    app.emit({ isActive: true });
    expect(cb.fakeSession.startCount).toBe(1);
  });

  it('does NOT start a new session when foregrounding within 30 minutes', async () => {
    const app = fakeApp();
    const cb = makeCallbacks({ initialLastActiveAt: 1_000 });
    let nowVal = 1_000 + 5 * 60 * 1000;
    await startLifecycleCapture(cb, {
      capacitor: nativeCap(),
      loadApp: async () => app,
      now: () => nowVal,
      moduleLoadTime: 0,
    });

    app.emit({ isActive: true });
    expect(cb.fakeSession.startCount).toBe(0);
  });

  it('lifecycle.event is always foreground or background', async () => {
    const app = fakeApp();
    const cb = makeCallbacks();
    let nowVal = 0;
    await startLifecycleCapture(cb, {
      capacitor: nativeCap(),
      loadApp: async () => app,
      now: () => nowVal,
      moduleLoadTime: 0,
    });

    app.emit({ isActive: true });
    nowVal = 100;
    app.emit({ isActive: false });
    nowVal = 200;
    app.emit({ isActive: true });

    for (const e of cb.events) {
      expect(['foreground', 'background']).toContain(e.attrs['lifecycle.event']);
      assertPrimitive(e.attrs);
      assertNoOtelKeys(e);
    }
  });

  it('background flush respects timeout via Promise.race', async () => {
    const app = fakeApp();
    const cb = makeCallbacks({
      flush: () => new Promise<void>(() => undefined), // never resolves
    });
    await startLifecycleCapture(cb, {
      capacitor: nativeCap(),
      loadApp: async () => app,
      now: () => 1,
      moduleLoadTime: 0,
      flushTimeoutMs: 20,
    });

    app.emit({ isActive: false });
    // Should not throw and should record the background event synchronously
    expect(cb.events.at(-1)!.attrs['lifecycle.event']).toBe('background');
    // wait past timeout
    await new Promise((r) => setTimeout(r, 40));
  });

  it('swallows flushPipeline rejection', async () => {
    const app = fakeApp();
    const cb = makeCallbacks({
      flush: () => {
        throw new Error('boom');
      },
    });
    await startLifecycleCapture(cb, {
      capacitor: nativeCap(),
      loadApp: async () => app,
      now: () => 1,
      moduleLoadTime: 0,
      flushTimeoutMs: 10,
    });

    expect(() => app.emit({ isActive: false })).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
  });

  it('falls back to document visibilitychange on web when no native', async () => {
    let listener: (() => void) | undefined;
    const doc = {
      visibilityState: 'visible' as 'visible' | 'hidden',
      addEventListener: vi.fn((_name: string, cb: () => void) => {
        listener = cb;
      }),
      removeEventListener: vi.fn(),
    };
    const cb = makeCallbacks();
    let nowVal = 100;
    await startLifecycleCapture(cb, {
      capacitor: { isNativePlatform: () => false },
      getDocument: () => doc,
      now: () => nowVal,
      moduleLoadTime: 50,
      flushTimeoutMs: 10,
    });

    expect(doc.addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    // simulate hidden -> background
    doc.visibilityState = 'hidden';
    listener!();
    expect(cb.events.at(-1)!.attrs['lifecycle.event']).toBe('background');
    expect(cb.flushPipeline).toHaveBeenCalledTimes(1);

    // simulate visible -> foreground
    doc.visibilityState = 'visible';
    listener!();
    expect(cb.events.at(-1)!.attrs['lifecycle.event']).toBe('foreground');
  });

  it('falls back to web visibility listener when native listener setup fails', async () => {
    const broken: AppModuleLike = {
      addListener: () => {
        throw new Error('no listener');
      },
    };
    const doc = {
      visibilityState: 'visible' as 'visible' | 'hidden',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const cb = makeCallbacks();
    await startLifecycleCapture(cb, {
      capacitor: nativeCap(),
      loadApp: async () => broken,
      getDocument: () => doc,
      now: () => 0,
      moduleLoadTime: 0,
    });
    expect(doc.addEventListener).toHaveBeenCalled();
  });

  it('stop() removes native listener', async () => {
    const app = fakeApp();
    const cb = makeCallbacks();
    const handle = await startLifecycleCapture(cb, {
      capacitor: nativeCap(),
      loadApp: async () => app,
      now: () => 0,
      moduleLoadTime: 0,
    });
    await handle.stop();
    expect(app.removed).toBe(true);
  });

  it('stop() removes web visibility listener', async () => {
    const doc = {
      visibilityState: 'visible' as 'visible' | 'hidden',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const cb = makeCallbacks();
    const handle = await startLifecycleCapture(cb, {
      capacitor: { isNativePlatform: () => false },
      getDocument: () => doc,
      now: () => 0,
      moduleLoadTime: 0,
    });
    await handle.stop();
    expect(doc.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});

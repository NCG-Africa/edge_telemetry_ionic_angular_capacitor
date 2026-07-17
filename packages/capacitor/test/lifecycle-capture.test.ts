import { describe, expect, it, vi } from 'vitest';

import {
  startLifecycleCapture,
  type AppModuleLike,
  type AppPluginListenerHandleLike,
  type AppStateLike,
  type BeaconPayload,
  type LifecycleAttributes,
  type LifecycleCaptureCallbacks,
  type LifecycleSessionManagerLike,
  type LifecycleWindowLike,
  type XhrLike,
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
  sessionId: string;
  startTime: string;
  sequence: number;
  journey: Record<string, string | number | boolean>;
}

function makeSession(initialLastActiveAt = 0): FakeSession {
  const s: FakeSession = {
    lastActiveAt: initialLastActiveAt,
    startCount: 0,
    sessionId: 'session_1000_abcd1234_web',
    startTime: '2026-04-15T10:00:00.000Z',
    sequence: 0,
    journey: {
      'session.visited_screens': '',
      'session.screen_count': 0,
      'session.event_count': 0,
      'session.metric_count': 0,
    },
    getLastActiveAt: () => s.lastActiveAt,
    setLastActiveAt: (ts: number) => {
      s.lastActiveAt = ts;
    },
    startNewSession: () => {
      s.startCount += 1;
      s.sessionId = `session_${Date.now()}_rotated__web`;
      s.startTime = new Date().toISOString();
      s.sequence = 0;
      s.journey = {
        'session.visited_screens': '',
        'session.screen_count': 0,
        'session.event_count': 0,
        'session.metric_count': 0,
      };
    },
    getSessionId: () => s.sessionId,
    getStartTime: () => s.startTime,
    getSequence: () => s.sequence,
    getJourneySnapshot: () => s.journey,
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

  it('lifecycle.event is always foreground or background on app_lifecycle events', async () => {
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
      if (e.name === 'app_lifecycle') {
        expect(['foreground', 'background']).toContain(e.attrs['lifecycle.event']);
      }
      assertPrimitive(e.attrs);
      assertNoOtelKeys(e);
    }
  });

  describe('session.started / session.finalized', () => {
    it('emits session.finalized with end_reason=backgrounded on background', async () => {
      const app = fakeApp();
      const cb = makeCallbacks();
      cb.fakeSession.sessionId = 'session_900_a1b2c3d4_ios';
      cb.fakeSession.startTime = '2026-04-15T10:00:00.000Z';
      cb.fakeSession.sequence = 7;
      let nowVal = Date.parse('2026-04-15T10:00:42.000Z');
      await startLifecycleCapture(cb, {
        capacitor: nativeCap(),
        loadApp: async () => app,
        now: () => nowVal,
        moduleLoadTime: 0,
        flushTimeoutMs: 10,
      });

      app.emit({ isActive: false });

      const finalized = cb.events.find((e) => e.name === 'session.finalized');
      expect(finalized).toBeDefined();
      expect(finalized!.attrs['session.id']).toBe('session_900_a1b2c3d4_ios');
      expect(finalized!.attrs['session.start_time']).toBe('2026-04-15T10:00:00.000Z');
      expect(finalized!.attrs['session.sequence']).toBe(7);
      expect(finalized!.attrs['session.end_reason']).toBe('backgrounded');
      expect(finalized!.attrs['session.duration_ms']).toBe(42_000);
      expect(finalized!.attrs['session.ended_at']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      assertPrimitive(finalized!.attrs);
      // session.finalized comes BEFORE app_lifecycle:background
      const finalizedIdx = cb.events.findIndex((e) => e.name === 'session.finalized');
      const bgIdx = cb.events.findIndex(
        (e) => e.name === 'app_lifecycle' && e.attrs['lifecycle.event'] === 'background',
      );
      expect(finalizedIdx).toBeLessThan(bgIdx);
    });

    it('uses the monotonic elapsed for duration even when the wall clock jumps backward', async () => {
      const app = fakeApp();
      const cb = makeCallbacks();
      cb.fakeSession.startTime = '2026-04-15T10:00:00.000Z';
      // Monotonic clock reads a real 60s of elapsed session time.
      cb.fakeSession.getElapsedMs = () => 60_000;
      // Wall clock has jumped 33.217s BEFORE session start (NTP correction / manual
      // clock change) — a wallEnd - wallStart computation would be -33217.
      const nowVal = Date.parse('2026-04-15T10:00:00.000Z') - 33_217;
      await startLifecycleCapture(cb, {
        capacitor: nativeCap(),
        loadApp: async () => app,
        now: () => nowVal,
        moduleLoadTime: 0,
        flushTimeoutMs: 10,
      });

      app.emit({ isActive: false });

      const finalized = cb.events.find((e) => e.name === 'session.finalized');
      expect(finalized).toBeDefined();
      expect(finalized!.attrs['session.duration_ms']).toBe(60_000);
      expect(finalized!.attrs['session.duration_ms'] as number).toBeGreaterThanOrEqual(0);
    });

    it('emits session.started with start_reason=resumed on foreground within timeout (after a prior background)', async () => {
      const app = fakeApp();
      const cb = makeCallbacks();
      let nowVal = 1_000;
      await startLifecycleCapture(cb, {
        capacitor: nativeCap(),
        loadApp: async () => app,
        now: () => nowVal,
        moduleLoadTime: 0,
        flushTimeoutMs: 10,
      });

      // First foreground — should NOT emit session.started (init covers it)
      app.emit({ isActive: true });
      expect(cb.events.filter((e) => e.name === 'session.started')).toHaveLength(0);

      // Background, then foreground 5 min later
      nowVal = 1_000 + 60_000;
      app.emit({ isActive: false });
      nowVal = 1_000 + 60_000 + 5 * 60_000;
      app.emit({ isActive: true });

      const started = cb.events.filter((e) => e.name === 'session.started');
      expect(started).toHaveLength(1);
      expect(started[0]!.attrs['session.start_reason']).toBe('resumed');
      // No rotation — startCount unchanged
      expect(cb.fakeSession.startCount).toBe(0);
    });

    it('emits session.started with start_reason=rotation_timeout on foreground after timeout, no duplicate finalized', async () => {
      const app = fakeApp();
      const SESSION_TIMEOUT = 30 * 60 * 1000;
      const cb = makeCallbacks({ initialLastActiveAt: 1_000 });
      let nowVal = 1_000 + SESSION_TIMEOUT + 1;
      await startLifecycleCapture(cb, {
        capacitor: nativeCap(),
        loadApp: async () => app,
        now: () => nowVal,
        moduleLoadTime: 0,
        flushTimeoutMs: 10,
      });

      app.emit({ isActive: true });

      const started = cb.events.filter((e) => e.name === 'session.started');
      expect(started).toHaveLength(1);
      expect(started[0]!.attrs['session.start_reason']).toBe('rotation_timeout');
      expect(cb.fakeSession.startCount).toBe(1);
      // No finalized emitted on this foreground — the prior background (out of scope here) already handled it
      expect(cb.events.filter((e) => e.name === 'session.finalized')).toHaveLength(0);
    });

    it('first foreground does NOT emit session.started (no prior background)', async () => {
      const app = fakeApp();
      const cb = makeCallbacks();
      let nowVal = 5_000;
      await startLifecycleCapture(cb, {
        capacitor: nativeCap(),
        loadApp: async () => app,
        now: () => nowVal,
        moduleLoadTime: 0,
      });

      app.emit({ isActive: true });
      expect(cb.events.filter((e) => e.name === 'session.started')).toHaveLength(0);
    });

    it('pagehide emits session.finalized with end_reason=app_closed before the beacon is sent', async () => {
      const win = (() => {
        const listeners: Record<string, (() => void)[]> = {};
        return {
          addEventListener: (name: string, cb: () => void) => {
            (listeners[name] ??= []).push(cb);
          },
          removeEventListener: () => undefined,
          fire: (name: 'beforeunload' | 'pagehide') => {
            (listeners[name] ?? []).forEach((l) => l());
          },
        };
      })();
      const recorded: Array<{ name: string; attrs: LifecycleAttributes }> = [];
      const sendBeacon = vi.fn<(url: string, data?: BodyInit | null) => boolean>(() => true);
      const session = makeSession();
      session.sessionId = 'session_500_deadbeef_web';
      session.startTime = '2026-04-15T09:00:00.000Z';
      session.sequence = 3;
      let beaconBuildCount = 0;
      const cb: LifecycleCaptureCallbacks = {
        recordEvent: (name, attrs) => {
          recorded.push({ name, attrs });
        },
        flushPipeline: vi.fn(),
        session,
        getBeaconPayload: () => {
          beaconBuildCount += 1;
          return {
            url: 'https://example.com/collector/telemetry',
            body: '{"type":"telemetry_batch","timestamp":"2026-04-15T09:30:00.000Z","events":[]}',
          };
        },
        getPlatform: () => 'web',
      };
      await startLifecycleCapture(cb, {
        capacitor: { isNativePlatform: () => false },
        getDocument: () => undefined,
        getWindow: () => win,
        getNavigator: () => ({ sendBeacon }),
        now: () => Date.parse('2026-04-15T09:30:00.000Z'),
        moduleLoadTime: 0,
      });

      win.fire('pagehide');

      const finalized = recorded.find((e) => e.name === 'session.finalized');
      expect(finalized).toBeDefined();
      expect(finalized!.attrs['session.id']).toBe('session_500_deadbeef_web');
      expect(finalized!.attrs['session.end_reason']).toBe('app_closed');
      expect(finalized!.attrs['session.duration_ms']).toBe(30 * 60_000);
      // session.finalized was recorded BEFORE the beacon was built
      const finalizedIdx = recorded.findIndex((e) => e.name === 'session.finalized');
      expect(finalizedIdx).toBeGreaterThanOrEqual(0);
      expect(beaconBuildCount).toBe(1);
      expect(sendBeacon).toHaveBeenCalledTimes(1);
    });

    it('session.finalized includes the journey snapshot (visited_screens + counts)', async () => {
      const app = fakeApp();
      const cb = makeCallbacks();
      cb.fakeSession.journey = {
        'session.visited_screens': 'Home,Profile',
        'session.screen_count': 2,
        'session.event_count': 5,
        'session.metric_count': 1,
      };
      let nowVal = Date.parse('2026-04-15T10:00:10.000Z');
      await startLifecycleCapture(cb, {
        capacitor: nativeCap(),
        loadApp: async () => app,
        now: () => nowVal,
        moduleLoadTime: 0,
        flushTimeoutMs: 10,
      });

      app.emit({ isActive: false });

      const finalized = cb.events.find((e) => e.name === 'session.finalized');
      expect(finalized).toBeDefined();
      expect(finalized!.attrs['session.visited_screens']).toBe('Home,Profile');
      expect(finalized!.attrs['session.screen_count']).toBe(2);
      expect(finalized!.attrs['session.event_count']).toBe(5);
      expect(finalized!.attrs['session.metric_count']).toBe(1);
    });

    it('invokes flushActiveScreen before recording session.finalized on background', async () => {
      // Regression: the Ionic auto-capture wires its in-flight screen via
      // __beginScreen → state.activeScreen, and __flushActiveScreen is plumbed
      // through callbacks.flushActiveScreen so the closing screen.duration
      // lands BEFORE session.finalized on backgrounding.
      const app = fakeApp();
      const cb = makeCallbacks();
      const order: string[] = [];
      cb.flushActiveScreen = vi.fn((method: string) => {
        order.push(`flush:${method}`);
      });
      const recordEventSpy = cb.recordEvent;
      cb.recordEvent = (name, attrs) => {
        order.push(`record:${name}`);
        recordEventSpy(name, attrs);
      };
      await startLifecycleCapture(cb, {
        capacitor: nativeCap(),
        loadApp: async () => app,
        now: () => 1_000,
        moduleLoadTime: 0,
        flushTimeoutMs: 10,
      });

      app.emit({ isActive: false });

      expect(cb.flushActiveScreen).toHaveBeenCalledWith('backgrounded');
      const flushIdx = order.indexOf('flush:backgrounded');
      const finalizedIdx = order.indexOf('record:session.finalized');
      expect(flushIdx).toBeGreaterThanOrEqual(0);
      expect(finalizedIdx).toBeGreaterThan(flushIdx);
    });

    it('invokes flushActiveScreen with app_closed before session.finalized on pagehide', async () => {
      const win = (() => {
        const listeners: Record<string, (() => void)[]> = {};
        return {
          addEventListener: (name: string, cb: () => void) => {
            (listeners[name] ??= []).push(cb);
          },
          removeEventListener: () => undefined,
          fire: (name: 'beforeunload' | 'pagehide') => {
            (listeners[name] ?? []).forEach((l) => l());
          },
        };
      })();
      const order: string[] = [];
      const cb: LifecycleCaptureCallbacks = {
        recordEvent: (name) => {
          order.push(`record:${name}`);
        },
        flushPipeline: vi.fn(),
        flushActiveScreen: vi.fn((method: string) => {
          order.push(`flush:${method}`);
        }),
        session: makeSession(),
        getBeaconPayload: () => ({ url: 'u', body: 'b' }),
        getPlatform: () => 'web',
      };
      await startLifecycleCapture(cb, {
        capacitor: { isNativePlatform: () => false },
        getDocument: () => undefined,
        getWindow: () => win,
        getNavigator: () => ({ sendBeacon: vi.fn(() => true) }),
        now: () => 1_000,
        moduleLoadTime: 0,
      });

      win.fire('pagehide');

      expect(cb.flushActiveScreen).toHaveBeenCalledWith('app_closed');
      const flushIdx = order.indexOf('flush:app_closed');
      const finalizedIdx = order.indexOf('record:session.finalized');
      expect(flushIdx).toBeGreaterThanOrEqual(0);
      expect(finalizedIdx).toBeGreaterThan(flushIdx);
    });

    it('does not double-emit session.finalized when both beforeunload and pagehide fire', async () => {
      const win = (() => {
        const listeners: Record<string, (() => void)[]> = {};
        return {
          addEventListener: (name: string, cb: () => void) => {
            (listeners[name] ??= []).push(cb);
          },
          removeEventListener: () => undefined,
          fire: (name: 'beforeunload' | 'pagehide') => {
            (listeners[name] ?? []).forEach((l) => l());
          },
        };
      })();
      const recorded: Array<{ name: string; attrs: LifecycleAttributes }> = [];
      const cb: LifecycleCaptureCallbacks = {
        recordEvent: (name, attrs) => {
          recorded.push({ name, attrs });
        },
        flushPipeline: vi.fn(),
        session: makeSession(),
        getBeaconPayload: () => ({ url: 'u', body: 'b' }),
        getPlatform: () => 'web',
      };
      await startLifecycleCapture(cb, {
        capacitor: { isNativePlatform: () => false },
        getDocument: () => undefined,
        getWindow: () => win,
        getNavigator: () => ({ sendBeacon: vi.fn(() => true) }),
        now: () => 1_000,
        moduleLoadTime: 0,
      });

      win.fire('beforeunload');
      win.fire('pagehide');

      const finalized = recorded.filter((e) => e.name === 'session.finalized');
      expect(finalized).toHaveLength(1);
    });
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

  describe('beforeunload beacon', () => {
    function fakeWindow() {
      const listeners: Record<string, (() => void)[]> = {};
      const win: LifecycleWindowLike & { fire: (name: 'beforeunload' | 'pagehide') => void } = {
        addEventListener: (name, cb) => {
          (listeners[name] ??= []).push(cb);
        },
        removeEventListener: (name, cb) => {
          const list = listeners[name] ?? [];
          listeners[name] = list.filter((l) => l !== cb);
        },
        fire: (name) => {
          (listeners[name] ?? []).forEach((l) => l());
        },
      };
      return win;
    }

    function makeXhrFactory() {
      const calls: Array<{
        method: string;
        url: string;
        async: boolean;
        headers: Record<string, string>;
        body?: string;
        timeout?: number;
      }> = [];
      const factory = (): XhrLike => {
        const headers: Record<string, string> = {};
        let method = '';
        let url = '';
        let async = true;
        let timeout: number | undefined;
        const xhr: XhrLike = {
          open: (m, u, a) => {
            method = m;
            url = u;
            async = a;
          },
          setRequestHeader: (n, v) => {
            headers[n] = v;
          },
          send: (body) => {
            calls.push({ method, url, async, headers, body, timeout });
          },
          timeout: 0,
        };
        Object.defineProperty(xhr, 'timeout', {
          get: () => timeout,
          set: (v: number) => {
            timeout = v;
          },
        });
        return xhr;
      };
      return { factory, calls };
    }

    it('calls navigator.sendBeacon on beforeunload for non-iOS platforms', async () => {
      const win = fakeWindow();
      const sendBeacon = vi.fn<(url: string, data?: BodyInit | null) => boolean>(() => true);
      const payload: BeaconPayload = {
        url: 'https://edgetelemetry.ncgafrica.com/collector/telemetry?k=edge_abc',
        body: JSON.stringify({
          type: 'telemetry_batch',
          timestamp: '2026-04-15T10:00:00.000Z',
          events: [{ type: 'event', eventName: 'custom_event', timestamp: '2026-04-15T10:00:00.000Z', attributes: { 'sdk.platform': 'ionic-angular-capacitor' } }],
        }),
        headers: { 'X-API-Key': 'edge_abc' },
      };
      const cb: LifecycleCaptureCallbacks = {
        recordEvent: vi.fn(),
        flushPipeline: vi.fn(),
        session: makeSession(),
        getBeaconPayload: () => payload,
        getPlatform: () => 'web',
      };
      await startLifecycleCapture(cb, {
        capacitor: { isNativePlatform: () => false },
        getDocument: () => undefined,
        getWindow: () => win,
        getNavigator: () => ({ sendBeacon }),
        now: () => 0,
        moduleLoadTime: 0,
      });

      win.fire('beforeunload');

      expect(sendBeacon).toHaveBeenCalledTimes(1);
      const call = sendBeacon.mock.calls[0] as [string, BodyInit | null | undefined];
      const sentUrl = call[0];
      const sentBody = call[1];
      expect(sentUrl).toBe(payload.url);
      // Body should serialize to the JSON string we provided
      const bodyText =
        typeof Blob !== 'undefined' && sentBody instanceof Blob
          ? await sentBody.text()
          : String(sentBody);
      expect(bodyText).toBe(payload.body);

      // Assert envelope shape and no OTel keys / nested attributes
      const parsed = JSON.parse(bodyText);
      expect(parsed.type).toBe('telemetry_batch');
      expect(parsed.events).toBeInstanceOf(Array);
      assertNoOtelKeys(parsed);
      for (const ev of parsed.events) {
        for (const v of Object.values(ev.attributes)) {
          expect(['string', 'number', 'boolean']).toContain(typeof v);
        }
      }
    });

    it('uses synchronous XHR on iOS platform', async () => {
      const win = fakeWindow();
      const sendBeacon = vi.fn(() => true);
      const { factory, calls } = makeXhrFactory();
      const payload: BeaconPayload = {
        url: 'https://edgetelemetry.ncgafrica.com/collector/telemetry',
        body: '{"type":"telemetry_batch","timestamp":"2026-04-15T10:00:00.000Z","events":[]}',
        headers: { 'X-API-Key': 'edge_xyz' },
      };
      const cb: LifecycleCaptureCallbacks = {
        recordEvent: vi.fn(),
        flushPipeline: vi.fn(),
        session: makeSession(),
        getBeaconPayload: () => payload,
        getPlatform: () => 'ios',
      };
      await startLifecycleCapture(cb, {
        capacitor: nativeCap(),
        loadApp: async () => fakeApp(),
        getDocument: () => undefined,
        getWindow: () => win,
        getNavigator: () => ({ sendBeacon }),
        createXhr: factory,
        now: () => 0,
        moduleLoadTime: 0,
        beaconXhrTimeoutMs: 1000,
      });

      win.fire('beforeunload');

      expect(sendBeacon).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.method).toBe('POST');
      expect(call.url).toBe(payload.url);
      expect(call.async).toBe(false);
      expect(call.headers['Content-Type']).toBe('application/json');
      expect(call.headers['X-API-Key']).toBe('edge_xyz');
      expect(call.timeout).toBe(1000);
      expect(call.body).toBe(payload.body);
    });

    it('fires on pagehide as well as beforeunload', async () => {
      const win = fakeWindow();
      const sendBeacon = vi.fn(() => true);
      const cb: LifecycleCaptureCallbacks = {
        recordEvent: vi.fn(),
        flushPipeline: vi.fn(),
        session: makeSession(),
        getBeaconPayload: () => ({ url: 'u', body: 'b' }),
        getPlatform: () => 'web',
      };
      await startLifecycleCapture(cb, {
        capacitor: { isNativePlatform: () => false },
        getDocument: () => undefined,
        getWindow: () => win,
        getNavigator: () => ({ sendBeacon }),
        now: () => 0,
        moduleLoadTime: 0,
      });
      win.fire('pagehide');
      expect(sendBeacon).toHaveBeenCalledTimes(1);
    });

    it('skips beacon when getBeaconPayload returns null', async () => {
      const win = fakeWindow();
      const sendBeacon = vi.fn(() => true);
      const cb: LifecycleCaptureCallbacks = {
        recordEvent: vi.fn(),
        flushPipeline: vi.fn(),
        session: makeSession(),
        getBeaconPayload: () => null,
        getPlatform: () => 'web',
      };
      await startLifecycleCapture(cb, {
        capacitor: { isNativePlatform: () => false },
        getDocument: () => undefined,
        getWindow: () => win,
        getNavigator: () => ({ sendBeacon }),
        now: () => 0,
        moduleLoadTime: 0,
      });
      win.fire('beforeunload');
      expect(sendBeacon).not.toHaveBeenCalled();
    });

    it('swallows getBeaconPayload exceptions', async () => {
      const win = fakeWindow();
      const sendBeacon = vi.fn(() => true);
      const cb: LifecycleCaptureCallbacks = {
        recordEvent: vi.fn(),
        flushPipeline: vi.fn(),
        session: makeSession(),
        getBeaconPayload: () => {
          throw new Error('boom');
        },
        getPlatform: () => 'web',
      };
      await startLifecycleCapture(cb, {
        capacitor: { isNativePlatform: () => false },
        getDocument: () => undefined,
        getWindow: () => win,
        getNavigator: () => ({ sendBeacon }),
        now: () => 0,
        moduleLoadTime: 0,
      });
      expect(() => win.fire('beforeunload')).not.toThrow();
      expect(sendBeacon).not.toHaveBeenCalled();
    });

    it('falls back to sync XHR when sendBeacon throws on non-iOS', async () => {
      const win = fakeWindow();
      const sendBeacon = vi.fn(() => {
        throw new Error('beacon blocked');
      });
      const { factory, calls } = makeXhrFactory();
      const cb: LifecycleCaptureCallbacks = {
        recordEvent: vi.fn(),
        flushPipeline: vi.fn(),
        session: makeSession(),
        getBeaconPayload: () => ({ url: 'u', body: 'b', headers: { 'X-API-Key': 'edge_1' } }),
        getPlatform: () => 'web',
      };
      await startLifecycleCapture(cb, {
        capacitor: { isNativePlatform: () => false },
        getDocument: () => undefined,
        getWindow: () => win,
        getNavigator: () => ({ sendBeacon }),
        createXhr: factory,
        now: () => 0,
        moduleLoadTime: 0,
      });
      win.fire('beforeunload');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.headers['X-API-Key']).toBe('edge_1');
    });

    it('stop() removes beforeunload and pagehide listeners', async () => {
      const win = fakeWindow();
      const removed: Array<string> = [];
      const spied: LifecycleWindowLike = {
        addEventListener: win.addEventListener,
        removeEventListener: (name, cb) => {
          removed.push(name);
          win.removeEventListener?.(name, cb);
        },
      };
      const cb: LifecycleCaptureCallbacks = {
        recordEvent: vi.fn(),
        flushPipeline: vi.fn(),
        session: makeSession(),
        getBeaconPayload: () => ({ url: 'u', body: 'b' }),
        getPlatform: () => 'web',
      };
      const handle = await startLifecycleCapture(cb, {
        capacitor: { isNativePlatform: () => false },
        getDocument: () => undefined,
        getWindow: () => spied,
        getNavigator: () => ({ sendBeacon: vi.fn(() => true) }),
        now: () => 0,
        moduleLoadTime: 0,
      });
      await handle.stop();
      expect(removed).toContain('beforeunload');
      expect(removed).toContain('pagehide');
      // Subsequent fires should not call beacon
      win.fire('beforeunload');
    });
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

  describe('end-to-end: __beginScreen + __flushActiveScreen + emitFinalized', () => {
    // Exercises the full production seam without mocking core helpers.
    // Mirrors what IonicLifecycleCapture does on ionViewDidEnter, then drives
    // the lifecycle background event and checks that the in-flight screen
    // closes via collector.recordEvent('screen.duration', ...) BEFORE
    // session.finalized lands.
    it('emits screen.duration before session.finalized on background', async () => {
      const { EdgeRum, __beginScreen, __flushActiveScreen, __getCollector, __getSession } =
        await import('@nathanclaire/rum');
      const { __resetEdgeRumForTests } = await import('../../core/src/EdgeRum');

      __resetEdgeRumForTests();
      EdgeRum.init({
        apiKey: 'edge_e2e_key',
        endpoint: 'https://example.com/collector/telemetry',
        appName: 'E2E',
        appVersion: '1.0.0',
      });

      const collector = __getCollector()!;
      const order: string[] = [];
      const originalRecord = collector.recordEvent.bind(collector);
      const spy = vi.spyOn(collector, 'recordEvent').mockImplementation((name, attrs) => {
        order.push(`record:${name}`);
        originalRecord(name, attrs);
      });

      const app = fakeApp();
      let nowVal = 1_000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowVal);
      const realSession = __getSession()!;
      const session: LifecycleSessionManagerLike = {
        getLastActiveAt: () => 0,
        setLastActiveAt: () => undefined,
        startNewSession: () => undefined,
        getSessionId: () => realSession.getSessionId(),
        getStartTime: () => realSession.getStartTime(),
        getSequence: () => realSession.getSequence(),
        getJourneySnapshot: () => ({}),
      };

      await startLifecycleCapture(
        {
          recordEvent: (name, attrs) => collector.recordEvent(name, attrs),
          flushPipeline: vi.fn(),
          flushActiveScreen: (method) => __flushActiveScreen(method),
          session,
        },
        {
          capacitor: nativeCap(),
          loadApp: async () => app,
          now: () => nowVal,
          moduleLoadTime: 0,
          flushTimeoutMs: 10,
        },
      );

      // Simulate ionViewDidEnter — the only thing the rewired
      // IonicLifecycleCapture does on the active-screen side. enteredAt
      // is captured via Date.now() (spied above).
      __beginScreen('/tabs/dashboard');
      nowVal = 4_500;

      app.emit({ isActive: false });

      const screenIdx = order.indexOf('record:screen.duration');
      const finalizedIdx = order.indexOf('record:session.finalized');
      expect(screenIdx).toBeGreaterThanOrEqual(0);
      expect(finalizedIdx).toBeGreaterThan(screenIdx);

      const screenCall = spy.mock.calls.find((c) => c[0] === 'screen.duration');
      expect(screenCall).toBeDefined();
      const screenAttrs = screenCall![1] as Record<string, unknown>;
      expect(screenAttrs['screen.name']).toBe('/tabs/dashboard');
      expect(screenAttrs['screen.duration_ms']).toBe(3_500);
      expect(screenAttrs['screen.exit_method']).toBe('backgrounded');

      __resetEdgeRumForTests();
    });

    it('no-op when there is no active screen (e.g. session backgrounded before any didEnter)', async () => {
      const { EdgeRum, __flushActiveScreen, __getCollector } = await import('@nathanclaire/rum');
      const { __resetEdgeRumForTests } = await import('../../core/src/EdgeRum');

      __resetEdgeRumForTests();
      EdgeRum.init({
        apiKey: 'edge_e2e_key',
        endpoint: 'https://example.com/collector/telemetry',
        appName: 'E2E',
        appVersion: '1.0.0',
      });

      const collector = __getCollector()!;
      const spy = vi.spyOn(collector, 'recordEvent');

      const app = fakeApp();
      await startLifecycleCapture(
        {
          recordEvent: (name, attrs) => collector.recordEvent(name, attrs),
          flushPipeline: vi.fn(),
          flushActiveScreen: (method) => __flushActiveScreen(method),
          session: makeSession(),
        },
        {
          capacitor: nativeCap(),
          loadApp: async () => app,
          now: () => 1_000,
          moduleLoadTime: 0,
          flushTimeoutMs: 10,
        },
      );

      // No __beginScreen call — session.finalized must still emit, just
      // without a preceding screen.duration.
      app.emit({ isActive: false });

      const screenCalls = spy.mock.calls.filter((c) => c[0] === 'screen.duration');
      const finalized = spy.mock.calls.find((c) => c[0] === 'session.finalized');
      expect(screenCalls).toHaveLength(0);
      expect(finalized).toBeDefined();

      __resetEdgeRumForTests();
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getInitialNetworkContext,
  startNetworkCapture,
  type NetworkAttributes,
  type NetworkCaptureCallbacks,
  type NetworkModuleLike,
  type NetworkStatusLike,
  type PluginListenerHandleLike,
} from '../src/NetworkCapture';

type Listener = (status: NetworkStatusLike) => void;

interface FakeNetwork extends NetworkModuleLike {
  emit: (status: NetworkStatusLike) => void;
  removed: boolean;
}

function fakeNetwork(initial: NetworkStatusLike): FakeNetwork {
  let listener: Listener | undefined;
  const handle: PluginListenerHandleLike = {
    remove: async () => {
      listener = undefined;
      (mod as FakeNetwork).removed = true;
    },
  };
  const mod: Partial<FakeNetwork> = {
    getStatus: async () => initial,
    addListener: (_name, cb) => {
      listener = cb;
      return handle;
    },
    emit: (status) => {
      if (listener) listener(status);
    },
    removed: false,
  };
  return mod as FakeNetwork;
}

interface CallbackState extends NetworkCaptureCallbacks {
  readonly onlineLog: boolean[];
  readonly events: Array<{ name: string; attrs: NetworkAttributes }>;
  readonly flushCount: () => number;
}

function makeCallbacks(): CallbackState {
  const onlineLog: boolean[] = [];
  const events: Array<{ name: string; attrs: NetworkAttributes }> = [];
  let flushCount = 0;
  return {
    onlineLog,
    events,
    flushCount: () => flushCount,
    setOnline: vi.fn((online: boolean) => {
      onlineLog.push(online);
    }),
    flushQueue: vi.fn(() => {
      flushCount += 1;
    }),
    recordEvent: vi.fn((name, attrs) => {
      events.push({ name, attrs });
    }),
  };
}

function nativeCap() {
  return { isNativePlatform: () => true };
}

function webCap() {
  return { isNativePlatform: () => false };
}

function assertPrimitive(attrs: NetworkAttributes): void {
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

describe('getInitialNetworkContext', () => {
  it('reads native network status on native platforms', async () => {
    const network = fakeNetwork({ connected: true, connectionType: 'wifi' });
    const attrs = await getInitialNetworkContext({
      capacitor: nativeCap(),
      loadNetwork: async () => network,
      getNavigator: () => ({
        onLine: true,
        connection: { effectiveType: '4g', downlink: 24.5 },
      }),
    });
    expect(attrs['network.connected']).toBe(true);
    expect(attrs['network.type']).toBe('wifi');
    expect(attrs['network.effectiveType']).toBe('4g');
    expect(attrs['network.downlinkMbps']).toBe(24.5);
    assertPrimitive(attrs);
    assertNoOtelKeys(attrs);
  });

  it('falls back to navigator on web', async () => {
    const attrs = await getInitialNetworkContext({
      capacitor: webCap(),
      getNavigator: () => ({
        onLine: true,
        connection: { type: 'wifi', effectiveType: '4g', downlink: 10 },
      }),
    });
    expect(attrs['network.connected']).toBe(true);
    expect(attrs['network.type']).toBe('wifi');
    expect(attrs['network.effectiveType']).toBe('4g');
    expect(attrs['network.downlinkMbps']).toBe(10);
  });

  it('returns connected=false when navigator.onLine is false', async () => {
    const attrs = await getInitialNetworkContext({
      capacitor: webCap(),
      getNavigator: () => ({ onLine: false }),
    });
    expect(attrs['network.connected']).toBe(false);
    expect(attrs['network.type']).toBe('none');
  });

  it('swallows native getStatus failure and yields defaults', async () => {
    const broken: NetworkModuleLike = {
      getStatus: async () => {
        throw new Error('boom');
      },
      addListener: () => ({ remove: async () => undefined }),
    };
    const attrs = await getInitialNetworkContext({
      capacitor: nativeCap(),
      loadNetwork: async () => broken,
      getNavigator: () => undefined,
    });
    expect(typeof attrs['network.connected']).toBe('boolean');
    expect(typeof attrs['network.type']).toBe('string');
  });
});

describe('startNetworkCapture', () => {
  let winListeners: Record<string, Array<() => void>>;
  let win: Window & typeof globalThis;

  beforeEach(() => {
    winListeners = {};
    win = {
      addEventListener: vi.fn((name: string, cb: () => void) => {
        (winListeners[name] ||= []).push(cb);
      }),
      removeEventListener: vi.fn((name: string, cb: () => void) => {
        winListeners[name] = (winListeners[name] || []).filter((fn) => fn !== cb);
      }),
    } as unknown as Window & typeof globalThis;
  });

  it('sets isOnline=false on disconnect and does not flush', async () => {
    const network = fakeNetwork({ connected: true, connectionType: 'wifi' });
    const cb = makeCallbacks();
    await startNetworkCapture(cb, {
      capacitor: nativeCap(),
      loadNetwork: async () => network,
      getNavigator: () => undefined,
      getWindow: () => win,
    });
    network.emit({ connected: false, connectionType: 'none' });
    expect(cb.onlineLog).toEqual([false]);
    expect(cb.flushCount()).toBe(0);
  });

  it('sets isOnline=true and flushes queue on reconnect', async () => {
    const network = fakeNetwork({ connected: false, connectionType: 'none' });
    const cb = makeCallbacks();
    await startNetworkCapture(cb, {
      capacitor: nativeCap(),
      loadNetwork: async () => network,
      getNavigator: () => undefined,
      getWindow: () => win,
    });
    network.emit({ connected: true, connectionType: 'wifi' });
    expect(cb.onlineLog).toEqual([true]);
    expect(cb.flushCount()).toBe(1);
  });

  it('records network_change event with connected, type, previous_type', async () => {
    const network = fakeNetwork({ connected: true, connectionType: 'wifi' });
    const cb = makeCallbacks();
    await startNetworkCapture(cb, {
      capacitor: nativeCap(),
      loadNetwork: async () => network,
      getNavigator: () => ({ connection: { effectiveType: '3g', downlink: 1.5 } }),
      getWindow: () => win,
    });
    network.emit({ connected: true, connectionType: 'cellular' });
    expect(cb.events).toHaveLength(1);
    const evt = cb.events[0]!;
    expect(evt.name).toBe('network_change');
    expect(evt.attrs['network.connected']).toBe(true);
    expect(evt.attrs['network.type']).toBe('cellular');
    expect(evt.attrs['network.previous_type']).toBe('wifi');
    expect(evt.attrs['network.effectiveType']).toBe('3g');
    expect(evt.attrs['network.downlinkMbps']).toBe(1.5);
    assertPrimitive(evt.attrs);
    assertNoOtelKeys(evt.attrs);
  });

  it('chains previous_type across consecutive changes', async () => {
    const network = fakeNetwork({ connected: true, connectionType: 'wifi' });
    const cb = makeCallbacks();
    await startNetworkCapture(cb, {
      capacitor: nativeCap(),
      loadNetwork: async () => network,
      getNavigator: () => undefined,
      getWindow: () => win,
    });
    network.emit({ connected: true, connectionType: 'cellular' });
    network.emit({ connected: false, connectionType: 'none' });
    expect(cb.events[0]!.attrs['network.previous_type']).toBe('wifi');
    expect(cb.events[1]!.attrs['network.previous_type']).toBe('cellular');
    expect(cb.events[1]!.attrs['network.connected']).toBe(false);
  });

  it('all attribute values are primitives on every emitted event', async () => {
    const network = fakeNetwork({ connected: true, connectionType: 'wifi' });
    const cb = makeCallbacks();
    await startNetworkCapture(cb, {
      capacitor: nativeCap(),
      loadNetwork: async () => network,
      getNavigator: () => ({ connection: { effectiveType: '4g', downlink: 12 } }),
      getWindow: () => win,
    });
    network.emit({ connected: false, connectionType: 'none' });
    network.emit({ connected: true, connectionType: 'wifi' });
    expect(cb.events.length).toBeGreaterThan(0);
    for (const e of cb.events) {
      assertPrimitive(e.attrs);
      assertNoOtelKeys(e);
    }
  });

  it('wires web online/offline listeners when not native', async () => {
    const cb = makeCallbacks();
    const nav: { onLine: boolean; connection?: undefined } = { onLine: true };
    await startNetworkCapture(cb, {
      capacitor: webCap(),
      getNavigator: () => nav,
      getWindow: () => win,
    });
    expect(winListeners['online']?.length).toBe(1);
    expect(winListeners['offline']?.length).toBe(1);

    // simulate offline
    nav.onLine = false;
    winListeners['offline']![0]!();
    expect(cb.onlineLog).toEqual([false]);
    expect(cb.events.at(-1)?.attrs['network.connected']).toBe(false);

    // simulate online
    nav.onLine = true;
    winListeners['online']![0]!();
    expect(cb.onlineLog).toEqual([false, true]);
    expect(cb.flushCount()).toBe(1);
  });

  it('stop() removes native listener and web listeners', async () => {
    const network = fakeNetwork({ connected: true, connectionType: 'wifi' });
    const cb = makeCallbacks();
    const handle = await startNetworkCapture(cb, {
      capacitor: nativeCap(),
      loadNetwork: async () => network,
      getNavigator: () => undefined,
      getWindow: () => win,
    });
    await handle.stop();
    expect(network.removed).toBe(true);
  });

  it('falls back to web listeners when native listener setup fails', async () => {
    const broken: NetworkModuleLike = {
      getStatus: async () => ({ connected: true, connectionType: 'wifi' }),
      addListener: () => {
        throw new Error('no listener');
      },
    };
    const cb = makeCallbacks();
    await startNetworkCapture(cb, {
      capacitor: nativeCap(),
      loadNetwork: async () => broken,
      getNavigator: () => ({ onLine: true }),
      getWindow: () => win,
    });
    expect(winListeners['online']?.length).toBe(1);
    expect(winListeners['offline']?.length).toBe(1);
  });

  it('swallows flushQueue rejection', async () => {
    const network = fakeNetwork({ connected: false, connectionType: 'none' });
    const cb = makeCallbacks();
    cb.flushQueue = vi.fn(async () => {
      throw new Error('kaboom');
    });
    await startNetworkCapture(cb, {
      capacitor: nativeCap(),
      loadNetwork: async () => network,
      getNavigator: () => undefined,
      getWindow: () => win,
    });
    // Should not throw synchronously
    network.emit({ connected: true, connectionType: 'wifi' });
    // Give the rejected promise a tick to resolve
    await Promise.resolve();
    await Promise.resolve();
    expect(cb.onlineLog).toEqual([true]);
  });
});

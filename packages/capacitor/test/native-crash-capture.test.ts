import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerNativeCrashCapture,
  type EdgeRumCrashPluginLike,
  type NativeCrashRecord,
} from '../src/NativeCrashCapture';

function makePlugin(overrides: Partial<EdgeRumCrashPluginLike> = {}): EdgeRumCrashPluginLike {
  return {
    install: vi.fn().mockResolvedValue({ installed: true }),
    fetchPending: vi.fn().mockResolvedValue({ crashes: [] }),
    markHandled: vi.fn().mockResolvedValue(undefined),
    setLastScreen: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function sampleCrash(id: string, overrides: Partial<NativeCrashRecord> = {}): NativeCrashRecord {
  return {
    id,
    ts: '2026-05-25T10:00:00.000Z',
    cause: 'NativeCrash',
    exception_type: 'EXC_BAD_ACCESS',
    message: 'segmentation fault',
    stacktrace: '0x100000abc\n0x100000def',
    is_fatal: true,
    handled: false,
    runtime: 'native',
    error_context: 'screen:/tabs/profile',
    platform: 'ios',
    platform_version: '17.4',
    signal: 'SIGSEGV',
    thread: 'main',
    symbolication: 'required',
    ...overrides,
  };
}

describe('registerNativeCrashCapture', () => {
  let recorded: Array<{ name: string; attrs: Record<string, unknown> }>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let subscribers: Array<(route: string) => void>;

  beforeEach(() => {
    recorded = [];
    subscribers = [];
    unsubscribe = vi.fn();
  });

  function setup(plugin: EdgeRumCrashPluginLike, opts: { now?: () => number; throttle?: number } = {}) {
    return registerNativeCrashCapture({
      recordEvent: (name, attrs) => recorded.push({ name, attrs }),
      subscribeToCurrentRoute: (cb) => {
        subscribers.push(cb);
        return unsubscribe;
      },
      plugin,
      now: opts.now,
      screenRelayThrottleMs: opts.throttle,
    });
  }

  it('returns a no-op handle when no plugin is available', async () => {
    const handle = await registerNativeCrashCapture({
      recordEvent: (name, attrs) => recorded.push({ name, attrs }),
      subscribeToCurrentRoute: (cb) => {
        subscribers.push(cb);
        return unsubscribe;
      },
      loadPlugin: async () => null,
    });
    expect(typeof handle.stop).toBe('function');
    expect(recorded).toHaveLength(0);
  });

  it('calls plugin.install once with the supplied options', async () => {
    const plugin = makePlugin();
    await registerNativeCrashCapture({
      recordEvent: (name, attrs) => recorded.push({ name, attrs }),
      subscribeToCurrentRoute: (cb) => {
        subscribers.push(cb);
        return unsubscribe;
      },
      plugin,
      enableAnrDetection: true,
      enableHangDetection: false,
      anrTimeoutMs: 7000,
      hangTimeoutMs: 4000,
    });
    expect(plugin.install).toHaveBeenCalledTimes(1);
    expect(plugin.install).toHaveBeenCalledWith({
      enableAnrDetection: true,
      enableHangDetection: false,
      anrTimeoutMs: 7000,
      hangTimeoutMs: 4000,
    });
  });

  it('emits app.crash for each pending record and marks them handled', async () => {
    const crashes = [
      sampleCrash('crash-1'),
      sampleCrash('crash-2', { cause: 'ANR', platform: 'android', signal: undefined, 'anr.duration_ms': 6500 }),
    ];
    const plugin = makePlugin({
      fetchPending: vi.fn().mockResolvedValue({ crashes }),
    });

    await setup(plugin);

    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.name).toBe('app.crash');
    expect(recorded[0]!.attrs['cause']).toBe('NativeCrash');
    expect(recorded[0]!.attrs['runtime']).toBe('native');
    expect(recorded[0]!.attrs['crash.signal']).toBe('SIGSEGV');
    expect(recorded[0]!.attrs['crash.platform']).toBe('ios');
    expect(recorded[0]!.attrs['crash.symbolication']).toBe('required');
    expect(recorded[1]!.attrs['cause']).toBe('ANR');
    expect(recorded[1]!.attrs['anr.duration_ms']).toBe(6500);
    expect(recorded[1]!.attrs['crash.platform']).toBe('android');

    expect(plugin.markHandled).toHaveBeenCalledTimes(1);
    expect(plugin.markHandled).toHaveBeenCalledWith({ ids: ['crash-1', 'crash-2'] });
  });

  it('does not call markHandled when there are no pending crashes', async () => {
    const plugin = makePlugin();
    await setup(plugin);
    expect(recorded).toHaveLength(0);
    expect(plugin.markHandled).not.toHaveBeenCalled();
  });

  it('survives a plugin.install rejection and still tries fetchPending', async () => {
    const plugin = makePlugin({
      install: vi.fn().mockRejectedValue(new Error('install failed')),
      fetchPending: vi.fn().mockResolvedValue({ crashes: [sampleCrash('x')] }),
    });
    await setup(plugin);
    expect(plugin.fetchPending).toHaveBeenCalled();
    expect(recorded).toHaveLength(1);
  });

  it('survives a fetchPending rejection without throwing', async () => {
    const plugin = makePlugin({
      fetchPending: vi.fn().mockRejectedValue(new Error('disk unreadable')),
    });
    await expect(setup(plugin)).resolves.toBeDefined();
    expect(recorded).toHaveLength(0);
    expect(plugin.markHandled).not.toHaveBeenCalled();
  });

  it('survives a markHandled rejection', async () => {
    const plugin = makePlugin({
      fetchPending: vi.fn().mockResolvedValue({ crashes: [sampleCrash('x')] }),
      markHandled: vi.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(setup(plugin)).resolves.toBeDefined();
    expect(recorded).toHaveLength(1);
  });

  it('relays currentRoute to plugin.setLastScreen, throttled', async () => {
    let now = 1000;
    const plugin = makePlugin();
    await setup(plugin, { now: () => now, throttle: 100 });

    expect(subscribers).toHaveLength(1);
    const fire = subscribers[0]!;

    fire('/home'); // immediate
    expect(plugin.setLastScreen).toHaveBeenCalledTimes(1);
    expect(plugin.setLastScreen).toHaveBeenLastCalledWith({ screen: '/home' });

    fire('/home'); // same route — ignored
    expect(plugin.setLastScreen).toHaveBeenCalledTimes(1);

    now = 1050;
    fire('/profile'); // within throttle window — coalesced
    expect(plugin.setLastScreen).toHaveBeenCalledTimes(1);

    fire('/settings'); // also within window, replaces pending
    expect(plugin.setLastScreen).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 80));
    now = 1100;
    await new Promise((r) => setTimeout(r, 5));

    expect(plugin.setLastScreen).toHaveBeenCalledTimes(2);
    expect(plugin.setLastScreen).toHaveBeenLastCalledWith({ screen: '/settings' });
  });

  it('stop() unsubscribes the currentRoute listener', async () => {
    const plugin = makePlugin();
    const handle = await setup(plugin);
    handle.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('attributes use canonical field names matching ErrorEventAttributes', async () => {
    const plugin = makePlugin({
      fetchPending: vi.fn().mockResolvedValue({ crashes: [sampleCrash('a')] }),
    });
    await setup(plugin);
    const attrs = recorded[0]!.attrs;
    // Compatibility with existing app.crash consumers
    expect(attrs).toHaveProperty('exception_type');
    expect(attrs).toHaveProperty('message');
    expect(attrs).toHaveProperty('stacktrace');
    expect(attrs).toHaveProperty('is_fatal');
    expect(attrs).toHaveProperty('handled');
    expect(attrs).toHaveProperty('error_context');
    expect(attrs).toHaveProperty('cause');
    expect(attrs).toHaveProperty('runtime');
    // Native-specific extensions are namespaced with crash.*
    expect(attrs).toHaveProperty('crash.id');
    expect(attrs).toHaveProperty('crash.captured_at');
    expect(attrs).toHaveProperty('crash.platform');
    // All values are primitives
    for (const v of Object.values(attrs)) {
      expect(['string', 'number', 'boolean']).toContain(typeof v);
    }
  });
});

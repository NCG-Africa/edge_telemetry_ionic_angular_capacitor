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
    startPerfSampling: vi.fn().mockResolvedValue({ started: true }),
    stopPerfSampling: vi.fn().mockResolvedValue(undefined),
    fetchFrameSamples: vi.fn().mockResolvedValue({ frames: [] }),
    fetchMemorySamples: vi.fn().mockResolvedValue({ samples: [] }),
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

  async function setup(plugin: EdgeRumCrashPluginLike, opts: { now?: () => number; throttle?: number; deferred?: boolean } = {}) {
    // Non-deferred path: capture the install Promise so we can await the
    // full install + fetchPending + markHandled chain before asserting on
    // side-effects. The SDK now passes installAndReplay directly to
    // scheduleIdle, so calling fn() returns its Promise.
    let installSettled: Promise<void> = Promise.resolve();
    const handle = await registerNativeCrashCapture({
      recordEvent: (name, attrs) => recorded.push({ name, attrs }),
      subscribeToCurrentRoute: (cb) => {
        subscribers.push(cb);
        return unsubscribe;
      },
      plugin,
      now: opts.now,
      screenRelayThrottleMs: opts.throttle,
      ...(opts.deferred
        ? {}
        : {
            scheduleIdle: (fn: () => void | Promise<void>) => {
              installSettled = Promise.resolve(fn());
            },
          }),
    });
    if (!opts.deferred) {
      await installSettled;
    }
    return handle;
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
    let installSettled: Promise<void> = Promise.resolve();
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
      scheduleIdle: (fn) => {
        installSettled = Promise.resolve(fn());
      },
    });
    await installSettled;
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

  describe('deferred install (default cold-start path)', () => {
    it('resolves the returned handle BEFORE plugin.install resolves (no bootstrap block)', async () => {
      let resolveInstall: (() => void) | null = null;
      const installPromise = new Promise<{ installed: boolean }>((resolve) => {
        resolveInstall = () => resolve({ installed: true });
      });
      const plugin = makePlugin({
        install: vi.fn(() => installPromise),
      });

      // No scheduleIdle override → uses the real default (setTimeout(0)).
      // Use a captured-scheduler hook to assert the work was deferred and
      // not awaited inline.
      let scheduledFn: (() => void) | null = null;
      const handle = await registerNativeCrashCapture({
        recordEvent: (name, attrs) => recorded.push({ name, attrs }),
        subscribeToCurrentRoute: (cb) => { subscribers.push(cb); return unsubscribe; },
        plugin,
        scheduleIdle: (fn) => { scheduledFn = fn; },
      });

      // Handle returned and plugin.install was NOT awaited inside register.
      expect(handle).toBeDefined();
      expect(plugin.install).not.toHaveBeenCalled();
      expect(scheduledFn).toBeTypeOf('function');

      // Now run the scheduled work: install starts, but the install promise
      // hasn't resolved yet.
      scheduledFn!();
      await Promise.resolve();
      expect(plugin.install).toHaveBeenCalledTimes(1);

      // Finally resolve install; fetchPending then runs.
      resolveInstall!();
      await new Promise((r) => setTimeout(r, 0));
      expect(plugin.fetchPending).toHaveBeenCalled();
    });

    it('replays pending crashes correctly on the deferred path', async () => {
      const plugin = makePlugin({
        fetchPending: vi.fn().mockResolvedValue({ crashes: [sampleCrash('deferred-1'), sampleCrash('deferred-2')] }),
      });
      let scheduledFn: (() => void) | null = null;
      await registerNativeCrashCapture({
        recordEvent: (name, attrs) => recorded.push({ name, attrs }),
        subscribeToCurrentRoute: (cb) => { subscribers.push(cb); return unsubscribe; },
        plugin,
        scheduleIdle: (fn) => { scheduledFn = fn; },
      });
      expect(recorded).toHaveLength(0); // nothing emitted yet — install was deferred

      scheduledFn!();
      // Drain microtasks for install + fetchPending + markHandled
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(recorded).toHaveLength(2);
      expect(plugin.markHandled).toHaveBeenCalledWith({ ids: ['deferred-1', 'deferred-2'] });
    });

    it('awaitNativeInstall: true makes the handle wait until install + fetchPending settle (opt-out path)', async () => {
      let installResolved = false;
      const plugin = makePlugin({
        install: vi.fn(async () => {
          await new Promise((r) => setTimeout(r, 5));
          installResolved = true;
          return { installed: true };
        }),
      });
      // Use a scheduler that throws if invoked — confirms we took the
      // awaitNativeInstall path, not the deferred path.
      const scheduleIdle = vi.fn(() => {
        throw new Error('scheduleIdle should not be called when awaitNativeInstall is true');
      });
      const handle = await registerNativeCrashCapture({
        recordEvent: (name, attrs) => recorded.push({ name, attrs }),
        subscribeToCurrentRoute: (cb) => { subscribers.push(cb); return unsubscribe; },
        plugin,
        awaitNativeInstall: true,
        scheduleIdle,
      });

      expect(installResolved).toBe(true);
      expect(handle).toBeDefined();
      expect(scheduleIdle).not.toHaveBeenCalled();
    });

    it('default scheduler is setTimeout(0) when requestIdleCallback is unavailable', async () => {
      const g = globalThis as unknown as { requestIdleCallback?: unknown };
      const saved = g.requestIdleCallback;
      delete g.requestIdleCallback;
      try {
        const plugin = makePlugin();
        // No scheduleIdle override — should pick the default.
        const before = Date.now();
        await registerNativeCrashCapture({
          recordEvent: (name, attrs) => recorded.push({ name, attrs }),
          subscribeToCurrentRoute: (cb) => { subscribers.push(cb); return unsubscribe; },
          plugin,
        });
        // The handle returned synchronously — install hasn't fired yet.
        expect(plugin.install).not.toHaveBeenCalled();
        // After a tick, the setTimeout(0) defer should fire.
        await new Promise((r) => setTimeout(r, 0));
        expect(plugin.install).toHaveBeenCalledTimes(1);
        expect(Date.now() - before).toBeLessThan(50);
      } finally {
        if (saved !== undefined) {
          (g as Record<string, unknown>).requestIdleCallback = saved;
        }
      }
    });
  });
});

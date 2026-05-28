import { describe, expect, it, vi } from 'vitest';

import { registerNativeCrashCapture, type NativeCrashRecord } from '../src/NativeCrashCapture';

// Shared spies + a faux Capacitor plugin proxy. The proxy intercepts every
// property access, including `then` — that mirrors how `@capacitor/core`'s
// registerPlugin proxy behaves. If the SDK ever returns this proxy directly
// from a Promise resolution, JavaScript's thenable assimilation will call
// `proxy.then(resolve, reject)`, Capacitor will route that to the native
// plugin, and Android will respond "EdgeRumCrash.then() is not implemented".
// The test asserts the wrapper in defaultLoadPlugin prevents that.
const mocks = vi.hoisted(() => {
  type Crashes = { crashes: NativeCrashRecord[] };
  const installSpy = vi.fn((_opts: unknown) => Promise.resolve({ installed: true }));
  const fetchPendingSpy = vi.fn((): Promise<Crashes> => Promise.resolve({ crashes: [] }));
  const markHandledSpy = vi.fn((_opts: { ids: string[] }) => Promise.resolve());
  const setLastScreenSpy = vi.fn((_opts: { screen: string }) => Promise.resolve());
  // Resolves with null so a regression (proxy.then accidentally invoked
  // during Promise assimilation) produces a clean assertion failure
  // downstream instead of hanging the test on an unresolved await.
  const thenSpy = vi.fn((resolve: (value: unknown) => void) => {
    resolve(null);
  });

  const handlers: Record<string, (arg?: unknown) => unknown> = {
    install: (arg) => installSpy(arg),
    fetchPending: () => fetchPendingSpy(),
    markHandled: (arg) => markHandledSpy(arg as { ids: string[] }),
    setLastScreen: (arg) => setLastScreenSpy(arg as { screen: string }),
    then: (arg) => thenSpy(arg as (value: unknown) => void),
  };

  const pluginProxy = new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      const fn = handlers[prop];
      if (fn) return fn;
      return () => Promise.resolve(undefined);
    },
  });

  return { installSpy, fetchPendingSpy, markHandledSpy, setLastScreenSpy, thenSpy, pluginProxy };
});

vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => mocks.pluginProxy),
}));

describe('defaultLoadPlugin proxy thenable guard', () => {
  it('never invokes proxy.then() when resolving the plugin', async () => {
    mocks.thenSpy.mockClear();
    mocks.installSpy.mockClear();

    const handle = await registerNativeCrashCapture({
      recordEvent: () => undefined,
      subscribeToCurrentRoute: () => () => undefined,
      awaitNativeInstall: true,
    });

    expect(mocks.thenSpy).not.toHaveBeenCalled();
    expect(mocks.installSpy).toHaveBeenCalledTimes(1);
    expect(typeof handle.stop).toBe('function');
  });

  it('still routes install/fetchPending/markHandled/setLastScreen to the underlying proxy', async () => {
    mocks.installSpy.mockClear();
    mocks.fetchPendingSpy.mockClear();
    mocks.markHandledSpy.mockClear();
    mocks.setLastScreenSpy.mockClear();
    const crash: NativeCrashRecord = {
      id: 'c1',
      ts: '2026-05-28T00:00:00.000Z',
      cause: 'NativeCrash',
      exception_type: 'EXC',
      message: 'm',
      stacktrace: 's',
      is_fatal: true,
      handled: false,
      runtime: 'native',
      error_context: '',
      platform: 'android',
    };
    mocks.fetchPendingSpy.mockResolvedValueOnce({ crashes: [crash] });

    let subscriber: ((route: string) => void) | null = null;
    await registerNativeCrashCapture({
      recordEvent: () => undefined,
      subscribeToCurrentRoute: (cb) => {
        subscriber = cb;
        return () => undefined;
      },
      awaitNativeInstall: true,
    });

    expect(mocks.installSpy).toHaveBeenCalledTimes(1);
    expect(mocks.fetchPendingSpy).toHaveBeenCalledTimes(1);
    expect(mocks.markHandledSpy).toHaveBeenCalledWith({ ids: ['c1'] });

    expect(subscriber).not.toBeNull();
    subscriber!('/tabs/home');
    expect(mocks.setLastScreenSpy).toHaveBeenCalledWith({ screen: '/tabs/home' });
  });
});

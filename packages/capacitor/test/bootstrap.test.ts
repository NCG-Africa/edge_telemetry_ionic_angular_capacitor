import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setTransportFetch = vi.fn();
const getSession = vi.fn(() => ({}));
const getCollector = vi.fn(() => ({ recordEvent: vi.fn() }));
const getContext = vi.fn(() => ({
  setDeviceAttributes: vi.fn(),
  setNetworkAttributes: vi.fn(),
}));
const getPipeline = vi.fn(() => ({
  markReady: vi.fn(),
  flush: vi.fn(),
  flushOfflineQueue: vi.fn(),
}));

const subscribeToCurrentRoute = vi.fn<(cb: (route: string) => void) => () => void>(() => () => undefined);
const reportError = vi.fn<(scope: string, err: unknown) => void>();

vi.mock('@nathanclaire/rum', () => ({
  __getSession: () => getSession(),
  __getCollector: () => getCollector(),
  __getContext: () => getContext(),
  __getPipeline: () => getPipeline(),
  __setTransportFetch: (fn: unknown) => setTransportFetch(fn),
  __subscribeToCurrentRoute: (cb: (route: string) => void) => subscribeToCurrentRoute(cb),
  healthMonitor: {
    reportError: (scope: string, err: unknown) => reportError(scope, err),
    setDebug: vi.fn(),
    getErrorCount: () => 0,
    getErrorsByScope: () => ({}),
    reset: vi.fn(),
  },
}));

vi.mock('../src/NativeCrashCapture', () => ({
  registerNativeCrashCapture: vi.fn(async () => ({ stop: () => undefined })),
}));

vi.mock('../src/DeviceContext', () => ({
  getDeviceContext: vi.fn(async () => ({})),
}));

vi.mock('../src/NetworkCapture', () => ({
  getInitialNetworkContext: vi.fn(async () => ({})),
  startNetworkCapture: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
}));

vi.mock('../src/LifecycleCapture', () => ({
  startLifecycleCapture: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
}));

interface GlobalWithCapacitor {
  Capacitor?: { isNativePlatform: () => boolean };
}

function setGlobalCapacitor(value: { isNativePlatform: () => boolean } | undefined): void {
  const g = globalThis as unknown as GlobalWithCapacitor;
  if (value === undefined) {
    delete g.Capacitor;
  } else {
    g.Capacitor = value;
  }
}

describe('startCapacitorCapture transport swap', () => {
  beforeEach(() => {
    setTransportFetch.mockClear();
  });

  afterEach(() => {
    setGlobalCapacitor(undefined);
  });

  it('swaps transport fetch when running on a native Capacitor platform', async () => {
    setGlobalCapacitor({ isNativePlatform: () => true });
    const { startCapacitorCapture } = await import('../src/bootstrap');
    await startCapacitorCapture();
    expect(setTransportFetch).toHaveBeenCalledTimes(1);
    expect(typeof setTransportFetch.mock.calls[0]?.[0]).toBe('function');
  });

  it('does not swap transport fetch when not on a native platform', async () => {
    setGlobalCapacitor({ isNativePlatform: () => false });
    const { startCapacitorCapture } = await import('../src/bootstrap');
    await startCapacitorCapture();
    expect(setTransportFetch).not.toHaveBeenCalled();
  });

  it('does not swap transport fetch when globalThis.Capacitor is absent', async () => {
    setGlobalCapacitor(undefined);
    const { startCapacitorCapture } = await import('../src/bootstrap');
    await startCapacitorCapture();
    expect(setTransportFetch).not.toHaveBeenCalled();
  });
});

describe('startCapacitorCapture native crash wiring', () => {
  beforeEach(async () => {
    setTransportFetch.mockClear();
    const { registerNativeCrashCapture } = (await import('../src/NativeCrashCapture')) as unknown as {
      registerNativeCrashCapture: ReturnType<typeof vi.fn>;
    };
    registerNativeCrashCapture.mockClear();
  });

  afterEach(() => {
    setGlobalCapacitor(undefined);
  });

  it('registers the native crash bridge when running on a native platform (default opt-in)', async () => {
    setGlobalCapacitor({ isNativePlatform: () => true });
    const { startCapacitorCapture } = await import('../src/bootstrap');
    const { registerNativeCrashCapture } = (await import('../src/NativeCrashCapture')) as unknown as {
      registerNativeCrashCapture: ReturnType<typeof vi.fn>;
    };
    await startCapacitorCapture();
    expect(registerNativeCrashCapture).toHaveBeenCalledTimes(1);
  });

  it('does NOT register the native crash bridge when captureNativeCrashes is false', async () => {
    setGlobalCapacitor({ isNativePlatform: () => true });
    const { startCapacitorCapture } = await import('../src/bootstrap');
    const { registerNativeCrashCapture } = (await import('../src/NativeCrashCapture')) as unknown as {
      registerNativeCrashCapture: ReturnType<typeof vi.fn>;
    };
    await startCapacitorCapture({ captureNativeCrashes: false });
    expect(registerNativeCrashCapture).not.toHaveBeenCalled();
  });

  it('does NOT register the native crash bridge on non-native platforms', async () => {
    setGlobalCapacitor({ isNativePlatform: () => false });
    const { startCapacitorCapture } = await import('../src/bootstrap');
    const { registerNativeCrashCapture } = (await import('../src/NativeCrashCapture')) as unknown as {
      registerNativeCrashCapture: ReturnType<typeof vi.fn>;
    };
    await startCapacitorCapture();
    expect(registerNativeCrashCapture).not.toHaveBeenCalled();
  });

  it('survives a registration failure (reports to healthMonitor, returns a working handle)', async () => {
    setGlobalCapacitor({ isNativePlatform: () => true });
    const { registerNativeCrashCapture } = (await import('../src/NativeCrashCapture')) as unknown as {
      registerNativeCrashCapture: ReturnType<typeof vi.fn>;
    };
    registerNativeCrashCapture.mockRejectedValueOnce(new Error('plugin missing'));
    const { startCapacitorCapture } = await import('../src/bootstrap');
    const handle = await startCapacitorCapture();
    expect(reportError).toHaveBeenCalledWith('native-crash.bootstrap', expect.any(Error));
    expect(typeof handle.stop).toBe('function');
  });
});

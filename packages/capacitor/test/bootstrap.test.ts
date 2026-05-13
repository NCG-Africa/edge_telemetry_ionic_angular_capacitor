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

vi.mock('@nathanclaire/rum', () => ({
  __getSession: () => getSession(),
  __getCollector: () => getCollector(),
  __getContext: () => getContext(),
  __getPipeline: () => getPipeline(),
  __setTransportFetch: (fn: unknown) => setTransportFetch(fn),
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

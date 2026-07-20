import { beforeEach, describe, expect, it, vi } from 'vitest';

import { startPerfSamplerCapture } from '../src/PerfSamplerCapture';
import type {
  EdgeRumCrashPluginLike,
  NativeFrameSummary,
  NativeMemorySample,
} from '../src/NativeCrashCapture';

function makePlugin(
  overrides: Partial<EdgeRumCrashPluginLike> = {},
): EdgeRumCrashPluginLike {
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

function frame(o: Partial<NativeFrameSummary> = {}): NativeFrameSummary {
  return {
    value: 24,
    frames_total: 100,
    slow_frames: 5,
    dropped_frames: 1,
    p50_ms: 16,
    p95_ms: 24,
    worst_ms: 40,
    window_ms: 1800,
    screen: '/tabs/profile',
    ...o,
  };
}

function mem(o: Partial<NativeMemorySample> = {}): NativeMemorySample {
  return {
    ts: '2026-05-28T10:00:00.000Z',
    value_mb: 100,
    type: 'rss',
    source: 'native',
    ...o,
  };
}

type Recorded = { metricName: string; value: number; attrs: Record<string, string | number | boolean> };

describe('startPerfSamplerCapture', () => {
  let recorded: Recorded[];

  beforeEach(() => {
    recorded = [];
  });

  it('returns a no-op handle when both captureFrames and captureMemory are false', async () => {
    const plugin = makePlugin();
    const handle = await startPerfSamplerCapture({
      plugin,
      recordMetric: (n, v, a) => recorded.push({ metricName: n, value: v, attrs: a }),
      options: { captureFrames: false, captureMemory: false },
      setInterval: () => 1,
      clearInterval: () => undefined,
    });

    expect(plugin.startPerfSampling).not.toHaveBeenCalled();
    expect(typeof handle.drainNow).toBe('function');
    await handle.stop();
  });

  it('calls startPerfSampling with the supplied options', async () => {
    const plugin = makePlugin();
    await startPerfSamplerCapture({
      plugin,
      recordMetric: (n, v, a) => recorded.push({ metricName: n, value: v, attrs: a }),
      options: {
        captureFrames: true,
        captureMemory: true,
        memorySamplingIntervalMs: 7000,
        frameSlowThresholdMs: 20,
        captureAllFrames: true,
      },
      setInterval: () => 1,
      clearInterval: () => undefined,
    });

    expect(plugin.startPerfSampling).toHaveBeenCalledWith({
      captureFrames: true,
      captureMemory: true,
      // The bridge translates the user-facing `memorySamplingIntervalMs`
      // (matching EdgeRumConfig) into the plugin-side `memoryIntervalMs` so
      // the native code can keep its naming concise.
      memoryIntervalMs: 7000,
      frameSlowThresholdMs: 20,
      captureAllFrames: true,
    });
  });

  it('translates windowed frame summaries into recordMetric calls with dotless keys', async () => {
    const plugin = makePlugin({
      fetchFrameSamples: vi.fn().mockResolvedValue({
        frames: [
          frame({
            value: 22,
            frames_total: 90,
            slow_frames: 4,
            dropped_frames: 0,
            p50_ms: 15,
            p95_ms: 22,
            worst_ms: 28,
            window_ms: 1500,
            screen: '/tabs/products',
          }),
          frame({
            value: 40,
            frames_total: 120,
            slow_frames: 9,
            dropped_frames: 3,
            p50_ms: 17,
            p95_ms: 40,
            worst_ms: 66,
            window_ms: 2000,
            screen: '/tabs/profile',
          }),
        ],
      }),
    });

    const handle = await startPerfSamplerCapture({
      plugin,
      recordMetric: (n, v, a) => recorded.push({ metricName: n, value: v, attrs: a }),
      setInterval: () => 1,
      clearInterval: () => undefined,
    });

    await handle.drainNow();

    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.metricName).toBe('frame_render_time');
    // Top-level value is the window p95.
    expect(recorded[0]!.value).toBe(22);
    expect(recorded[0]!.attrs).toMatchObject({
      frames_total: 90,
      slow_frames: 4,
      dropped_frames: 0,
      p50_ms: 15,
      p95_ms: 22,
      worst_ms: 28,
      window_ms: 1500,
      'metric.screen': '/tabs/products',
    });
    expect(recorded[1]!.value).toBe(40);
    expect(recorded[1]!.attrs['metric.screen']).toBe('/tabs/profile');
    for (const r of recorded) {
      // Old per-sample attrs must be gone.
      expect(r.attrs).not.toHaveProperty('frame_build_duration');
      expect(r.attrs).not.toHaveProperty('frame_raster_duration');
      expect(r.attrs).not.toHaveProperty('frame_type');
      expect(r.attrs).not.toHaveProperty('frame_dropped');
      expect(r.attrs).not.toHaveProperty('unit');
    }
  });

  it('translates memory samples and uses metricName "memory_usage"', async () => {
    const plugin = makePlugin({
      fetchMemorySamples: vi.fn().mockResolvedValue({
        samples: [
          mem({ value_mb: 245.6, pressure: 'normal', type: 'pss', source: 'native' }),
          mem({ value_mb: 410, pressure: 'critical', type: 'pss', source: 'native' }),
        ],
      }),
    });

    const handle = await startPerfSamplerCapture({
      plugin,
      recordMetric: (n, v, a) => recorded.push({ metricName: n, value: v, attrs: a }),
      setInterval: () => 1,
      clearInterval: () => undefined,
    });

    await handle.drainNow();

    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.metricName).toBe('memory_usage');
    expect(recorded[0]!.value).toBeCloseTo(245.6, 5);
    expect(recorded[0]!.attrs).toMatchObject({
      unit: 'MB',
      memory_type: 'pss',
      memory_source: 'native',
      memory_pressure_level: 'normal',
    });
    expect(recorded[1]!.attrs.memory_pressure_level).toBe('critical');
  });

  it('omits memory_pressure_level when pressure is undefined or empty', async () => {
    const plugin = makePlugin({
      fetchMemorySamples: vi.fn().mockResolvedValue({
        samples: [mem({ pressure: undefined }), mem({ pressure: '' as 'normal' })],
      }),
    });

    const handle = await startPerfSamplerCapture({
      plugin,
      recordMetric: (n, v, a) => recorded.push({ metricName: n, value: v, attrs: a }),
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    await handle.drainNow();

    for (const r of recorded) {
      expect(r.attrs).not.toHaveProperty('memory_pressure_level');
    }
  });

  it('does not call fetchFrameSamples when captureFrames is false', async () => {
    const plugin = makePlugin();
    const handle = await startPerfSamplerCapture({
      plugin,
      recordMetric: (n, v, a) => recorded.push({ metricName: n, value: v, attrs: a }),
      options: { captureFrames: false, captureMemory: true },
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    await handle.drainNow();
    expect(plugin.fetchFrameSamples).not.toHaveBeenCalled();
    expect(plugin.fetchMemorySamples).toHaveBeenCalled();
  });

  it('does not call fetchMemorySamples when captureMemory is false', async () => {
    const plugin = makePlugin();
    const handle = await startPerfSamplerCapture({
      plugin,
      recordMetric: (n, v, a) => recorded.push({ metricName: n, value: v, attrs: a }),
      options: { captureFrames: true, captureMemory: false },
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    await handle.drainNow();
    expect(plugin.fetchMemorySamples).not.toHaveBeenCalled();
    expect(plugin.fetchFrameSamples).toHaveBeenCalled();
  });

  it('drives the interval drainer at the configured cadence', async () => {
    const plugin = makePlugin({
      fetchMemorySamples: vi.fn().mockResolvedValue({ samples: [mem()] }),
    });
    let savedCb: (() => void) | null = null;
    const handle = await startPerfSamplerCapture({
      plugin,
      recordMetric: (n, v, a) => recorded.push({ metricName: n, value: v, attrs: a }),
      options: { drainIntervalMs: 1234, captureFrames: false, captureMemory: true },
      setInterval: (cb) => {
        savedCb = cb;
        return 1;
      },
      clearInterval: () => undefined,
    });

    expect(savedCb).not.toBeNull();
    savedCb!();
    // Wait one microtask flush for the async drainNow inside the interval cb
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    await handle.stop();
  });

  it('stop clears the interval, performs a final drain, and stops native sampling', async () => {
    const plugin = makePlugin({
      fetchMemorySamples: vi.fn().mockResolvedValue({ samples: [mem({ value_mb: 50 })] }),
    });
    let cleared: unknown = null;
    const handle = await startPerfSamplerCapture({
      plugin,
      recordMetric: (n, v, a) => recorded.push({ metricName: n, value: v, attrs: a }),
      setInterval: () => 'token',
      clearInterval: (h) => {
        cleared = h;
      },
    });

    await handle.stop();

    expect(cleared).toBe('token');
    expect(plugin.stopPerfSampling).toHaveBeenCalledTimes(1);
    expect(recorded.some((r) => r.metricName === 'memory_usage')).toBe(true);
  });

  it('returns a no-op handle when the plugin loader returns null', async () => {
    const handle = await startPerfSamplerCapture({
      recordMetric: (n, v, a) => recorded.push({ metricName: n, value: v, attrs: a }),
      loadPlugin: async () => null,
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    expect(recorded).toHaveLength(0);
    expect(typeof handle.stop).toBe('function');
    await handle.stop();
  });

  it('swallows fetch errors and continues draining', async () => {
    let frameCalls = 0;
    const plugin = makePlugin({
      fetchFrameSamples: vi.fn().mockImplementation(async () => {
        frameCalls++;
        if (frameCalls === 1) throw new Error('boom');
        return { frames: [frame({ value: 19 })] };
      }),
    });
    const handle = await startPerfSamplerCapture({
      plugin,
      recordMetric: (n, v, a) => recorded.push({ metricName: n, value: v, attrs: a }),
      options: { captureFrames: true, captureMemory: false },
      setInterval: () => 1,
      clearInterval: () => undefined,
    });

    await handle.drainNow(); // throws internally, swallowed
    expect(recorded).toHaveLength(0);
    await handle.drainNow(); // succeeds
    expect(recorded.some((r) => r.metricName === 'frame_render_time')).toBe(true);
    await handle.stop();
  });

  it('no OTel field names appear in emitted attributes', async () => {
    const plugin = makePlugin({
      fetchFrameSamples: vi.fn().mockResolvedValue({ frames: [frame()] }),
      fetchMemorySamples: vi.fn().mockResolvedValue({ samples: [mem()] }),
    });
    const handle = await startPerfSamplerCapture({
      plugin,
      recordMetric: (n, v, a) => recorded.push({ metricName: n, value: v, attrs: a }),
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    await handle.drainNow();
    const json = JSON.stringify(recorded);
    expect(json).not.toMatch(/traceId/i);
    expect(json).not.toMatch(/spanId/i);
    expect(json).not.toMatch(/opentelemetry/i);
    await handle.stop();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { startPerfSamplerCapture } from '../src/PerfSamplerCapture';
import type {
  EdgeRumCrashPluginLike,
  NativeFrameSample,
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

function frame(o: Partial<NativeFrameSample> = {}): NativeFrameSample {
  return {
    ts: '2026-05-28T10:00:00.000Z',
    total_ms: 24,
    build_ms: 18,
    raster_ms: 6,
    dropped: false,
    type: 'ui',
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

  it('translates frame samples into recordMetric calls with dotless keys', async () => {
    const plugin = makePlugin({
      fetchFrameSamples: vi.fn().mockResolvedValue({
        frames: [
          frame({ total_ms: 22, build_ms: 12, raster_ms: 10, dropped: false }),
          frame({ total_ms: 40, build_ms: 30, raster_ms: 10, dropped: true }),
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
    expect(recorded[0]!.value).toBe(22);
    expect(recorded[0]!.attrs).toMatchObject({
      unit: 'ms',
      frame_build_duration: 12,
      frame_raster_duration: 10,
      frame_type: 'ui',
      frame_dropped: false,
    });
    expect(recorded[1]!.value).toBe(40);
    expect(recorded[1]!.attrs.frame_dropped).toBe(true);
    for (const r of recorded) {
      expect(r.attrs).not.toHaveProperty('frame.build_duration_ms');
      expect(r.attrs).not.toHaveProperty('frame.dropped');
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
        return { frames: [frame({ total_ms: 19 })] };
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

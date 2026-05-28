import { describe, expect, it } from 'vitest';

import { registerMemoryWebCapture } from '../src/instrumentation/memory-web';

type Recorded = { metricName: string; value: number; attrs: Record<string, string | number | boolean> };

function makePerf(usedJSHeapSize: number | undefined): { memory?: { usedJSHeapSize?: number } } {
  if (usedJSHeapSize === undefined) return {};
  return { memory: { usedJSHeapSize } };
}

describe('registerMemoryWebCapture', () => {
  it('returns a no-op handle when performance.memory is unavailable', () => {
    const recorded: Recorded[] = [];
    const handle = registerMemoryWebCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getPerformance: () => makePerf(undefined),
    });
    expect(typeof handle.dispose).toBe('function');
    expect(recorded).toHaveLength(0);
  });

  it('emits one initial sample at registration time and uses metricName "memory_usage"', () => {
    const recorded: Recorded[] = [];
    registerMemoryWebCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getPerformance: () => makePerf(50 * 1024 * 1024),
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.metricName).toBe('memory_usage');
    expect(recorded[0]!.value).toBeCloseTo(50, 5);
  });

  it('uses dotless attribute keys and the correct MB unit', () => {
    const recorded: Recorded[] = [];
    registerMemoryWebCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getPerformance: () => makePerf(100 * 1024 * 1024),
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
    });

    const attrs = recorded[0]!.attrs;
    expect(attrs).toHaveProperty('unit', 'MB');
    expect(attrs).toHaveProperty('memory_type', 'heap');
    expect(attrs).toHaveProperty('memory_source', 'javascript');
    expect(attrs).not.toHaveProperty('memory.type');
    expect(attrs).not.toHaveProperty('memory.source');
  });

  it('omits memory_pressure_level when no pressure signal is available', () => {
    const recorded: Recorded[] = [];
    registerMemoryWebCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getPerformance: () => makePerf(20 * 1024 * 1024),
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
    });
    expect(recorded[0]!.attrs).not.toHaveProperty('memory_pressure_level');
  });

  it('value is a finite number in megabytes (top-level, not in attributes)', () => {
    const recorded: Recorded[] = [];
    registerMemoryWebCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getPerformance: () => makePerf(123_456_789),
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
    });
    expect(typeof recorded[0]!.value).toBe('number');
    expect(Number.isFinite(recorded[0]!.value)).toBe(true);
    expect(recorded[0]!.value).toBeCloseTo(123_456_789 / (1024 * 1024), 5);
    expect(recorded[0]!.attrs).not.toHaveProperty('value');
  });

  it('drives periodic sampling at the configured interval', () => {
    const recorded: Recorded[] = [];
    let savedCb: (() => void) | null = null;
    registerMemoryWebCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getPerformance: () => makePerf(10 * 1024 * 1024),
      intervalMs: 1234,
      setInterval: (cb) => {
        savedCb = cb;
        return 99 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => undefined,
    });

    // Initial + manual three ticks
    expect(recorded).toHaveLength(1);
    savedCb!();
    savedCb!();
    savedCb!();
    expect(recorded).toHaveLength(4);
  });

  it('skips sampling when usedJSHeapSize disappears (e.g., feature flag flip)', () => {
    const recorded: Recorded[] = [];
    let used: number | undefined = 10 * 1024 * 1024;
    let savedCb: (() => void) | null = null;
    registerMemoryWebCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getPerformance: () => (used !== undefined ? makePerf(used) : { memory: {} }),
      setInterval: (cb) => {
        savedCb = cb;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => undefined,
    });
    expect(recorded).toHaveLength(1);

    used = undefined;
    savedCb!();
    savedCb!();
    expect(recorded).toHaveLength(1);
  });

  it('sampleNow triggers an immediate emit', () => {
    const recorded: Recorded[] = [];
    const handle = registerMemoryWebCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getPerformance: () => makePerf(5 * 1024 * 1024),
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
    });
    handle.sampleNow();
    handle.sampleNow();
    expect(recorded).toHaveLength(3);
  });

  it('dispose calls clearInterval with the registered handle', () => {
    let cleared: unknown = null;
    const handle = registerMemoryWebCapture({
      recordMetric: () => undefined,
      getPerformance: () => makePerf(1024 * 1024),
      setInterval: () => 'token' as unknown as ReturnType<typeof setInterval>,
      clearInterval: (h) => {
        cleared = h;
      },
    });
    handle.dispose();
    expect(cleared).toBe('token');
  });

  it('no OTel field names appear in emitted attributes', () => {
    const recorded: Recorded[] = [];
    registerMemoryWebCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getPerformance: () => makePerf(8 * 1024 * 1024),
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
    });
    const json = JSON.stringify(recorded[0]);
    expect(json).not.toMatch(/traceId/i);
    expect(json).not.toMatch(/spanId/i);
    expect(json).not.toMatch(/opentelemetry/i);
  });
});

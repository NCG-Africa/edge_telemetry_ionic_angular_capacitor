import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerFrameCapture } from '../src/instrumentation/frames';

interface FakeObserver {
  observe: () => void;
  disconnect: () => void;
  emit: (entries: Array<{ startTime: number; duration: number }>) => void;
  disconnected: boolean;
}

interface ObserverCtor {
  (callback: (list: { getEntries: () => Array<{ startTime: number; duration: number }> }) => void): FakeObserver;
  supportedEntryTypes?: string[];
}

function makeObserverFactory(): { ctor: ObserverCtor; instances: FakeObserver[] } {
  const instances: FakeObserver[] = [];
  const ctor = function (
    cb: (list: { getEntries: () => Array<{ startTime: number; duration: number }> }) => void,
  ): FakeObserver {
    const obs: FakeObserver = {
      observe: () => undefined,
      disconnect: () => {
        obs.disconnected = true;
      },
      emit: (entries) => cb({ getEntries: () => entries }),
      disconnected: false,
    };
    instances.push(obs);
    return obs;
  } as unknown as ObserverCtor;
  ctor.supportedEntryTypes = ['longtask'];
  return { ctor, instances };
}

type Recorded = { metricName: string; value: number; attrs: Record<string, string | number | boolean> };

interface FakeRaf {
  schedule: (cb: (ts: number) => void) => number;
  cancel: (handle: number) => void;
  tick: (ts: number) => void;
  pending: Array<(ts: number) => void>;
}

function makeRaf(): FakeRaf {
  let nextHandle = 1;
  const map = new Map<number, (ts: number) => void>();
  return {
    schedule: (cb) => {
      const h = nextHandle++;
      map.set(h, cb);
      return h;
    },
    cancel: (handle) => {
      map.delete(handle);
    },
    tick: (ts) => {
      const cbs = Array.from(map.values());
      map.clear();
      for (const cb of cbs) cb(ts);
    },
    get pending() {
      return Array.from(map.values());
    },
  };
}

describe('registerFrameCapture', () => {
  const g = globalThis as unknown as { PerformanceObserver?: unknown };
  let originalPO: unknown;

  beforeEach(() => {
    originalPO = g.PerformanceObserver;
  });

  afterEach(() => {
    if (originalPO === undefined) delete g.PerformanceObserver;
    else g.PerformanceObserver = originalPO;
  });

  it('emits no events on the first frame (no previous timestamp)', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/home',
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    raf.tick(100);
    expect(recorded).toHaveLength(0);
  });

  it('only emits slow frames by default (>= 16.67 ms delta)', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/home',
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    raf.tick(0);
    raf.tick(10); // fast — 10ms, skipped
    raf.tick(30); // slow — 20ms
    raf.tick(50); // slow — 20ms

    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.value).toBeCloseTo(20, 5);
    expect(recorded[1]!.value).toBeCloseTo(20, 5);
  });

  it('uses metricName "frame_render_time" and dotless attribute keys', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/products/42',
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    raf.tick(0);
    raf.tick(20);

    expect(recorded[0]!.metricName).toBe('frame_render_time');
    const a = recorded[0]!.attrs;
    expect(a).toHaveProperty('unit', 'ms');
    expect(typeof a.frame_build_duration).toBe('number');
    expect(typeof a.frame_raster_duration).toBe('number');
    expect(a.frame_type).toBe('ui');
    expect(typeof a.frame_dropped).toBe('boolean');
    expect(a['metric.screen']).toBe('/products/42');
    expect(a).not.toHaveProperty('frame.build_duration_ms');
    expect(a).not.toHaveProperty('frame.raster_duration_ms');
  });

  it('marks frame_dropped true when interval >= 2x slow threshold (default 33.34 ms)', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/',
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    raf.tick(0);
    raf.tick(20);  // slow but not dropped
    raf.tick(60);  // dropped — 40ms gap

    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.attrs.frame_dropped).toBe(false);
    expect(recorded[1]!.attrs.frame_dropped).toBe(true);
  });

  it('frame_dropped is always boolean — never omitted', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/',
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    raf.tick(0);
    raf.tick(20);

    expect(Object.keys(recorded[0]!.attrs)).toContain('frame_dropped');
    expect(typeof recorded[0]!.attrs.frame_dropped).toBe('boolean');
  });

  it('frame_build_duration + frame_raster_duration are always numbers (never null)', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/',
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    raf.tick(0);
    raf.tick(20);
    raf.tick(45);

    for (const r of recorded) {
      expect(typeof r.attrs.frame_build_duration).toBe('number');
      expect(typeof r.attrs.frame_raster_duration).toBe('number');
      expect(Number.isFinite(r.attrs.frame_build_duration as number)).toBe(true);
      expect(Number.isFinite(r.attrs.frame_raster_duration as number)).toBe(true);
    }
  });

  it('emits all frames when captureAllFrames is true', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/',
      captureAllFrames: true,
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    raf.tick(0);
    raf.tick(8);
    raf.tick(16);
    raf.tick(24);

    expect(recorded).toHaveLength(3);
  });

  it('respects a custom slowThresholdMs', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/',
      slowThresholdMs: 50,
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    raf.tick(0);
    raf.tick(40); // below 50 → skip
    raf.tick(100); // 60ms → emit
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.value).toBeCloseTo(60, 5);
    expect(recorded[0]!.attrs.frame_dropped).toBe(false); // 60 < 100 (2 * 50)
  });

  it('derives frame_build_duration from overlapping longtask entries', () => {
    const { ctor, instances } = makeObserverFactory();
    g.PerformanceObserver = ctor;

    const recorded: Recorded[] = [];
    const raf = makeRaf();
    registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/',
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    // Emit a longtask that overlaps the upcoming frame interval [100, 130].
    expect(instances).toHaveLength(1);
    instances[0]!.emit([{ startTime: 105, duration: 15 }]);

    raf.tick(100);
    raf.tick(130);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.attrs.frame_build_duration).toBeCloseTo(15, 5);
    expect(recorded[0]!.attrs.frame_raster_duration).toBeCloseTo(15, 5);
  });

  it('falls back to total/0 split when no longtask overlaps the frame', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/',
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    raf.tick(0);
    raf.tick(20);

    expect(recorded[0]!.attrs.frame_build_duration).toBeCloseTo(20, 5);
    expect(recorded[0]!.attrs.frame_raster_duration).toBe(0);
  });

  it('dispose stops the rAF loop', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    const handle = registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/',
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    raf.tick(0);
    raf.tick(20);
    expect(recorded).toHaveLength(1);

    handle.dispose();
    raf.tick(60);
    raf.tick(100);
    expect(recorded).toHaveLength(1);
  });

  it('no-op when requestAnimationFrame is not available', () => {
    const recorded: Recorded[] = [];
    // Don't pass rafScheduler; let it consult globalThis where rAF is missing.
    const g2 = globalThis as unknown as { requestAnimationFrame?: unknown };
    const orig = g2.requestAnimationFrame;
    delete g2.requestAnimationFrame;
    try {
      const handle = registerFrameCapture({
        recordMetric: (n, v, a) => recorded.push({ metricName: n, value: v, attrs: a }),
        getCurrentRoute: () => '/',
      });
      expect(typeof handle.dispose).toBe('function');
      expect(recorded).toHaveLength(0);
    } finally {
      if (orig !== undefined) g2.requestAnimationFrame = orig;
    }
  });

  it('no OTel field names appear in emitted attributes', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/',
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });
    raf.tick(0);
    raf.tick(20);
    const json = JSON.stringify(recorded[0]);
    expect(json).not.toMatch(/traceId/i);
    expect(json).not.toMatch(/spanId/i);
    expect(json).not.toMatch(/opentelemetry/i);
  });
});

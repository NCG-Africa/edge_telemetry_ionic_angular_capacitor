import { describe, expect, it } from 'vitest';

import { registerFrameCapture } from '../src/instrumentation/frames';

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

describe('registerFrameCapture (windowed aggregation, ADR-030)', () => {
  it('emits nothing while a window is open — one summary only on flush', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    const handle = registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/home',
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    raf.tick(0);
    raf.tick(20); // 20ms slow
    raf.tick(30); // 10ms fast
    raf.tick(70); // 40ms dropped
    expect(recorded).toHaveLength(0); // window still open — no per-frame emit

    handle.dispose(); // flushes the in-progress window
    expect(recorded).toHaveLength(1);
    const r = recorded[0]!;
    expect(r.metricName).toBe('frame_render_time');
    expect(r.attrs.frames_total).toBe(3);
    expect(r.attrs.slow_frames).toBe(2); // 20, 40
    expect(r.attrs.dropped_frames).toBe(1); // 40 >= 33.34
    expect(r.attrs.p50_ms).toBeCloseTo(20, 5);
    expect(r.attrs.p95_ms).toBeCloseTo(40, 5);
    expect(r.attrs.worst_ms).toBeCloseTo(40, 5);
    expect(r.attrs.window_ms).toBeCloseTo(70, 5);
    expect(r.value).toBeCloseTo(40, 5); // top-level value == p95
    expect(r.attrs['metric.screen']).toBe('/home');
  });

  it('suppresses a smooth window entirely (slow_frames == 0)', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    const handle = registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/home',
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    raf.tick(0);
    raf.tick(10);
    raf.tick(20);
    raf.tick(30); // all 10ms — smooth

    handle.dispose();
    expect(recorded).toHaveLength(0);
  });

  it('suppresses an empty window (no frames observed)', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    const handle = registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/home',
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    raf.tick(0); // only sets prevTimestamp — no frame yet
    handle.dispose();
    expect(recorded).toHaveLength(0);
  });

  it('closes and emits the window on route change, then opens a fresh one', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    let route = '/a';
    const handle = registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => route,
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    raf.tick(0);
    raf.tick(20); // /a — 20ms slow
    raf.tick(50); // /a — 30ms slow
    route = '/b';
    raf.tick(70); // route changed → flush /a, this 20ms frame opens /b
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.attrs['metric.screen']).toBe('/a');
    expect(recorded[0]!.attrs.frames_total).toBe(2);
    expect(recorded[0]!.attrs.slow_frames).toBe(2);
    expect(recorded[0]!.attrs.window_ms).toBeCloseTo(50, 5);

    raf.tick(110); // /b — 40ms slow
    handle.dispose();
    expect(recorded).toHaveLength(2);
    expect(recorded[1]!.attrs['metric.screen']).toBe('/b');
    expect(recorded[1]!.attrs.frames_total).toBe(2); // the 20ms straddle + the 40ms
  });

  it('force-closes the window at MAX_WINDOW_MS (30000ms)', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    const handle = registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/feed',
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    raf.tick(0);
    raf.tick(20); // 20ms slow — window opens at 0
    raf.tick(30020); // 30020 - 0 >= 30000 → flush prior window, open new
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.attrs.frames_total).toBe(1);
    expect(recorded[0]!.attrs.window_ms).toBeCloseTo(20, 5);

    handle.dispose(); // the big straddling frame (30000ms) is itself slow → emits
    expect(recorded).toHaveLength(2);
    expect(recorded[1]!.attrs.frames_total).toBe(1);
    expect(recorded[1]!.attrs.worst_ms).toBeCloseTo(30000, 5);
  });

  it('respects a custom slowThresholdMs for slow/dropped counts', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    const handle = registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/',
      slowThresholdMs: 50,
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    raf.tick(0);
    raf.tick(40); // 40ms — below 50, not slow
    raf.tick(100); // 60ms — slow, below 100 (2x) so not dropped
    handle.dispose();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.attrs.frames_total).toBe(2);
    expect(recorded[0]!.attrs.slow_frames).toBe(1);
    expect(recorded[0]!.attrs.dropped_frames).toBe(0);
    expect(recorded[0]!.value).toBeCloseTo(60, 5);
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
    handle.dispose();
    expect(raf.pending).toHaveLength(0);

    const before = recorded.length;
    raf.tick(60);
    raf.tick(100);
    expect(recorded).toHaveLength(before); // no further emits after dispose
  });

  it('no-op when requestAnimationFrame is not available', () => {
    const recorded: Recorded[] = [];
    const g = globalThis as unknown as { requestAnimationFrame?: unknown };
    const orig = g.requestAnimationFrame;
    delete g.requestAnimationFrame;
    try {
      const handle = registerFrameCapture({
        recordMetric: (n, v, a) => recorded.push({ metricName: n, value: v, attrs: a }),
        getCurrentRoute: () => '/',
      });
      expect(typeof handle.dispose).toBe('function');
      handle.dispose();
      expect(recorded).toHaveLength(0);
    } finally {
      if (orig !== undefined) g.requestAnimationFrame = orig;
    }
  });

  it('emits only dotless attributes with no OTel field names or build/raster split', () => {
    const recorded: Recorded[] = [];
    const raf = makeRaf();
    const handle = registerFrameCapture({
      recordMetric: (metricName, value, attrs) => recorded.push({ metricName, value, attrs }),
      getCurrentRoute: () => '/products/42',
      rafScheduler: raf.schedule,
      rafCanceller: raf.cancel,
    });

    raf.tick(0);
    raf.tick(20);
    handle.dispose();

    const r = recorded[0]!;
    const a = r.attrs;
    // Build/raster split and old per-sample keys are gone from the wire.
    expect(a).not.toHaveProperty('frame_build_duration');
    expect(a).not.toHaveProperty('frame_raster_duration');
    expect(a).not.toHaveProperty('frame_type');
    expect(a).not.toHaveProperty('frame_dropped');
    expect(a).not.toHaveProperty('unit');
    // Attributes are flat primitives.
    for (const v of Object.values(a)) {
      expect(['string', 'number', 'boolean']).toContain(typeof v);
    }
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/traceId/i);
    expect(json).not.toMatch(/spanId/i);
    expect(json).not.toMatch(/opentelemetry/i);
  });
});

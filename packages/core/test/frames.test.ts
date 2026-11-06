import { afterEach, describe, expect, it } from 'vitest';

import { registerFrameCapture, type FramesDeps } from '../src/instrumentation/frames';

type Attrs = Record<string, string | number | boolean>;

function makeRaf() {
  let nextHandle = 1;
  const map = new Map<number, (ts: number) => void>();
  return {
    schedule: (cb: (ts: number) => void) => {
      const h = nextHandle++;
      map.set(h, cb);
      return h;
    },
    cancel: (handle: number) => {
      map.delete(handle);
    },
    tick: (ts: number) => {
      const cbs = Array.from(map.values());
      map.clear();
      for (const cb of cbs) cb(ts);
    },
    get pending() {
      return Array.from(map.values());
    },
  };
}

function setup(over: Partial<FramesDeps> = {}) {
  const recorded: Attrs[] = [];
  const raf = makeRaf();
  const input = new EventTarget();
  let routeChanged = (): void => undefined;
  const handle = registerFrameCapture({
    record: (attrs) => recorded.push(attrs),
    getCurrentRoute: () => '/home',
    rafScheduler: raf.schedule,
    rafCanceller: raf.cancel,
    activityTarget: input,
    onRouteChange: (f) => {
      routeChanged = f;
      return () => undefined;
    },
    ...over,
  });
  return { recorded, raf, input, handle, routeChanged: () => routeChanged() };
}

describe('registerFrameCapture (E20 frame.summary, ADR-030 windows)', () => {
  it('emits nothing while a window is open — one frame.summary with Cordova E20 keys on close', () => {
    const { recorded, raf, handle } = setup();
    raf.tick(0);
    raf.tick(40); // slow
    raf.tick(50); // 10 ms
    raf.tick(800); // 750 ms: slow and frozen
    expect(recorded).toHaveLength(0);

    handle.dispose();
    expect(recorded).toEqual([{
      'screen.name': '/home',
      'frame.total_frames': 3,
      'frame.slow_frames': 2,
      'frame.frozen_frames': 1,
      'frame.max_total_duration_ms': 750,
      'frame.slow_frame_rate': 0.6667,
      'frame.window_duration_ms': 800,
      'frame.source': 'raf',
    }]);
  });

  it('suppresses a smooth window (no slow frame) and an empty one', () => {
    const smooth = setup();
    for (const t of [0, 17, 33, 50]) smooth.raf.tick(t); // 60 Hz jitter is not slow
    smooth.handle.dispose();
    expect(smooth.recorded).toHaveLength(0);

    const empty = setup();
    empty.raf.tick(0); // only the first tick: no frame yet
    empty.handle.dispose();
    expect(empty.recorded).toHaveLength(0);
  });

  it('closes the window on route change, then opens a fresh one', () => {
    let route = '/a';
    const { recorded, raf, handle } = setup({ getCurrentRoute: () => route });
    raf.tick(0);
    raf.tick(40);
    raf.tick(80);
    route = '/b';
    raf.tick(120); // route changed: flush /a; this frame opens /b
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ 'screen.name': '/a', 'frame.total_frames': 2, 'frame.slow_frames': 2, 'frame.window_duration_ms': 80 });

    raf.tick(160);
    handle.dispose();
    expect(recorded[1]).toMatchObject({ 'screen.name': '/b', 'frame.total_frames': 2 });
  });

  it('force-closes the window at 30 s', () => {
    const { recorded, raf, input, handle } = setup();
    raf.tick(0);
    raf.tick(40);
    input.dispatchEvent(new Event('pointerdown')); // keeps the loop awake across the long frame
    raf.tick(30040);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ 'frame.total_frames': 1, 'frame.window_duration_ms': 40 });

    handle.dispose();
    expect(recorded[1]).toMatchObject({ 'frame.total_frames': 1, 'frame.max_total_duration_ms': 30000 });
  });

  it('respects a custom slowThresholdMs', () => {
    const { recorded, raf, handle } = setup({ slowThresholdMs: 50 });
    raf.tick(0);
    raf.tick(40); // below 50
    raf.tick(100); // 60: slow
    handle.dispose();
    expect(recorded[0]).toMatchObject({ 'frame.total_frames': 2, 'frame.slow_frames': 1, 'frame.frozen_frames': 0 });
  });

  it('dispose stops the rAF loop and emits nothing more', () => {
    const { recorded, raf, handle } = setup();
    raf.tick(0);
    raf.tick(40);
    handle.dispose();
    expect(raf.pending).toHaveLength(0);
    const before = recorded.length;
    raf.tick(100);
    raf.tick(200);
    expect(recorded).toHaveLength(before);
  });

  it('no-op when requestAnimationFrame is not available', () => {
    const recorded: Attrs[] = [];
    const handle = registerFrameCapture({ record: (a) => recorded.push(a), getCurrentRoute: () => '/', onRouteChange: () => () => undefined });
    expect(() => handle.dispose()).not.toThrow();
    expect(recorded).toHaveLength(0);
  });

  it('pauses after 2 s without input and resumes on the next input or Ionic transition', () => {
    const { recorded, raf, input, handle } = setup();
    raf.tick(0);
    raf.tick(40);
    raf.tick(2000); // idle: window closes, no further frame requested
    expect(raf.pending).toHaveLength(0);
    expect(recorded).toHaveLength(1);

    input.dispatchEvent(new Event('ionViewWillEnter'));
    expect(raf.pending).toHaveLength(1);
    raf.tick(5000);
    raf.tick(5016);
    expect(raf.pending).toHaveLength(1);
    handle.dispose();
  });

  it('resumes on a route change (E20)', () => {
    const { raf, routeChanged, handle } = setup();
    raf.tick(0);
    raf.tick(2000);
    expect(raf.pending).toHaveLength(0);
    routeChanged();
    expect(raf.pending).toHaveLength(1);
    handle.dispose();
  });

  it('closes the window on hide; hidden time is never a frame', () => {
    const g = globalThis as Record<string, unknown>;
    const d = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    g.document = d;
    try {
      const { recorded, raf, handle } = setup({ activityTarget: undefined });
      raf.tick(0);
      raf.tick(40);
      d.visibilityState = 'hidden';
      d.dispatchEvent(new Event('visibilitychange'));
      expect(recorded).toHaveLength(1);
      d.visibilityState = 'visible';
      d.dispatchEvent(new Event('visibilitychange'));
      raf.tick(1500); // first tick after showing: a fresh gap, not a 1460 ms frame
      raf.tick(1516);
      handle.dispose();
      expect(recorded).toHaveLength(1); // the 16 ms frame is smooth
    } finally {
      delete g.document;
    }
  });

  describe('frame.long_task_count', () => {
    const g = globalThis as Record<string, unknown>;
    afterEach(() => {
      delete g.PerformanceObserver;
    });

    it('counts long tasks inside the window where the WebView reports them', () => {
      let report: (list: { getEntries: () => unknown[] }) => void = () => undefined;
      g.PerformanceObserver = Object.assign(
        function (cb: typeof report) {
          report = cb;
          return { observe: () => undefined, disconnect: () => undefined };
        },
        { supportedEntryTypes: ['longtask'] },
      );
      const { recorded, raf, handle } = setup();
      raf.tick(0);
      raf.tick(120);
      report({ getEntries: () => [{}, {}] });
      handle.dispose();
      expect(recorded[0]).toMatchObject({ 'frame.long_task_count': 2 });
    });

    it('omits the key where long tasks are not supported', () => {
      const { recorded, raf, handle } = setup();
      raf.tick(0);
      raf.tick(120);
      handle.dispose();
      expect(recorded[0]).not.toHaveProperty('frame.long_task_count');
    });
  });
});

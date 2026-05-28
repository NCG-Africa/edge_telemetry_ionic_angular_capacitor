import type { EventAttributes } from '../index';
import { healthMonitor } from '../internal/health';

export interface FramesDeps {
  recordMetric: (metricName: string, value: number, attributes: EventAttributes) => void;
  getCurrentRoute: () => string;
  slowThresholdMs?: number;
  captureAllFrames?: boolean;
  // Test seams
  rafScheduler?: (cb: (timestamp: number) => void) => number;
  rafCanceller?: (handle: number) => void;
  now?: () => number;
}

export interface FramesHandle {
  dispose: () => void;
}

const DEFAULT_SLOW_THRESHOLD_MS = 16.67;
// At 60Hz, one missed vsync is 33.34ms. Two consecutive missed vsyncs at the
// default threshold marks the frame "dropped" on the wire.
const DROP_MULTIPLIER = 2;
// Keep a short window of long tasks so we can attribute build time to a frame
// even if the longtask observer fires slightly after the rAF callback.
const LONG_TASK_WINDOW = 32;

interface LongTaskEntry {
  startTime: number;
  duration: number;
}

type ObserverLike = {
  observe: (options: { entryTypes?: string[]; type?: string; buffered?: boolean }) => void;
  disconnect: () => void;
};

function getPerformanceObserverCtor():
  | (new (cb: (list: PerformanceObserverEntryList) => void) => ObserverLike)
  | undefined {
  const g = globalThis as unknown as {
    PerformanceObserver?: new (cb: (list: PerformanceObserverEntryList) => void) => ObserverLike;
  };
  return g.PerformanceObserver;
}

function supportsLongTask(): boolean {
  const Ctor = getPerformanceObserverCtor() as unknown as { supportedEntryTypes?: string[] };
  return Array.isArray(Ctor?.supportedEntryTypes) && Ctor.supportedEntryTypes.includes('longtask');
}

function defaultRafScheduler(cb: (timestamp: number) => void): number {
  const g = globalThis as unknown as { requestAnimationFrame?: (cb: (ts: number) => void) => number };
  if (typeof g.requestAnimationFrame !== 'function') return 0;
  return g.requestAnimationFrame(cb);
}

function defaultRafCanceller(handle: number): void {
  const g = globalThis as unknown as { cancelAnimationFrame?: (handle: number) => void };
  if (typeof g.cancelAnimationFrame === 'function') g.cancelAnimationFrame(handle);
}

function defaultNow(): number {
  const g = globalThis as unknown as { performance?: { now: () => number } };
  if (g.performance && typeof g.performance.now === 'function') return g.performance.now();
  return Date.now();
}

// `requestAnimationFrame` may be missing in non-DOM environments (SSR, jsdom
// without rAF polyfill, Node). Skip silently rather than throwing.
function rafAvailable(deps: FramesDeps): boolean {
  if (typeof deps.rafScheduler === 'function') return true;
  const g = globalThis as unknown as { requestAnimationFrame?: unknown };
  return typeof g.requestAnimationFrame === 'function';
}

export function registerFrameCapture(deps: FramesDeps): FramesHandle {
  if (!rafAvailable(deps)) {
    return { dispose: () => undefined };
  }

  const slowThreshold = deps.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
  const dropThreshold = slowThreshold * DROP_MULTIPLIER;
  const captureAll = deps.captureAllFrames === true;
  const raf = deps.rafScheduler ?? defaultRafScheduler;
  const cancelRaf = deps.rafCanceller ?? defaultRafCanceller;
  const now = deps.now ?? defaultNow;

  const longTaskRing: LongTaskEntry[] = [];
  let observer: ObserverLike | null = null;
  if (supportsLongTask()) {
    const Ctor = getPerformanceObserverCtor();
    if (Ctor) {
      try {
        observer = new Ctor((list) => {
          for (const entry of list.getEntries()) {
            longTaskRing.push({ startTime: entry.startTime, duration: entry.duration });
            if (longTaskRing.length > LONG_TASK_WINDOW) longTaskRing.shift();
          }
        });
        observer.observe({ type: 'longtask', buffered: true });
      } catch (err) {
        healthMonitor.reportError('frames.longtask.setup', err);
      }
    }
  }

  // Returns the longest long-task duration that overlapped the frame interval.
  // The Long Tasks API surfaces main-thread blocks; treating the largest
  // overlap as the frame's "build" portion lines up with the Flutter SDK's
  // build/raster split semantics for WebView frames without requiring the
  // browser to expose a real frame timing API.
  function buildDurationForFrame(frameStart: number, frameEnd: number): number {
    let best = 0;
    for (const entry of longTaskRing) {
      const entryEnd = entry.startTime + entry.duration;
      if (entryEnd < frameStart || entry.startTime > frameEnd) continue;
      const overlap = Math.min(entryEnd, frameEnd) - Math.max(entry.startTime, frameStart);
      if (overlap > best) best = overlap;
    }
    return best;
  }

  let prevTimestamp = -1;
  let rafHandle: number | null = null;
  let disposed = false;

  const tick = (timestamp: number): void => {
    if (disposed) return;
    if (prevTimestamp >= 0) {
      const total = Math.max(0, timestamp - prevTimestamp);
      if (captureAll || total >= slowThreshold) {
        try {
          const build = buildDurationForFrame(prevTimestamp, timestamp);
          const raster = Math.max(0, total - build);
          const dropped = total >= dropThreshold;
          const attrs: EventAttributes = {
            unit: 'ms',
            frame_build_duration: build > 0 ? build : total,
            frame_raster_duration: build > 0 ? raster : 0,
            frame_type: 'ui',
            frame_dropped: dropped,
            'metric.screen': deps.getCurrentRoute(),
          };
          deps.recordMetric('frame_render_time', total, attrs);
        } catch (err) {
          healthMonitor.reportError('frames.emit', err);
        }
      }
    }
    prevTimestamp = timestamp;
    // Reference `now` so the linter is happy and to keep a single capture
    // function point even when tests stub timing.
    void now;
    rafHandle = raf(tick);
  };

  rafHandle = raf(tick);

  return {
    dispose: () => {
      disposed = true;
      if (rafHandle !== null) {
        try {
          cancelRaf(rafHandle);
        } catch (err) {
          healthMonitor.reportError('frames.cancel', err);
        }
        rafHandle = null;
      }
      if (observer) {
        try {
          observer.disconnect();
        } catch (err) {
          healthMonitor.reportError('frames.disconnect', err);
        }
        observer = null;
      }
    },
  };
}

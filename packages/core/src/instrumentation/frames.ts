import type { EventAttributes } from '../index';
import { healthMonitor } from '../internal/health';

export interface FramesDeps {
  recordMetric: (metricName: string, value: number, attributes: EventAttributes) => void;
  getCurrentRoute: () => string;
  slowThresholdMs?: number;
  // Test seams
  rafScheduler?: (cb: (timestamp: number) => void) => number;
  rafCanceller?: (handle: number) => void;
}

export interface FramesHandle {
  dispose: () => void;
}

const DEFAULT_SLOW_THRESHOLD_MS = 16.67;
// At 60Hz, one missed vsync is 33.34ms. Two consecutive missed vsyncs at the
// default threshold marks the frame "dropped" on the wire.
const DROP_MULTIPLIER = 2;
// A window force-closes after this long so a screen scrolled for minutes
// produces several summaries rather than one coarse blob. Internal constant
// (ADR-030) — no config knob.
const MAX_WINDOW_MS = 30000;

function defaultRafScheduler(cb: (timestamp: number) => void): number {
  const g = globalThis as unknown as { requestAnimationFrame?: (cb: (ts: number) => void) => number };
  if (typeof g.requestAnimationFrame !== 'function') return 0;
  return g.requestAnimationFrame(cb);
}

function defaultRafCanceller(handle: number): void {
  const g = globalThis as unknown as { cancelAnimationFrame?: (handle: number) => void };
  if (typeof g.cancelAnimationFrame === 'function') g.cancelAnimationFrame(handle);
}

// `requestAnimationFrame` may be missing in non-DOM environments (SSR, jsdom
// without rAF polyfill, Node). Skip silently rather than throwing.
function rafAvailable(deps: FramesDeps): boolean {
  if (typeof deps.rafScheduler === 'function') return true;
  const g = globalThis as unknown as { requestAnimationFrame?: unknown };
  return typeof g.requestAnimationFrame === 'function';
}

// Nearest-rank percentile over an ascending-sorted array. Window is bounded
// (≤ 30s ≈ ≤ ~1800 frames), so a sort-once-on-flush beats any streaming estimator.
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.ceil(p * sortedAsc.length) - 1;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, idx))] ?? 0;
}

export function registerFrameCapture(deps: FramesDeps): FramesHandle {
  if (!rafAvailable(deps)) {
    return { dispose: () => undefined };
  }

  const slowThreshold = deps.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
  const dropThreshold = slowThreshold * DROP_MULTIPLIER;
  const raf = deps.rafScheduler ?? defaultRafScheduler;
  const cancelRaf = deps.rafCanceller ?? defaultRafCanceller;

  // In-window state. `durations` accumulates every frame observed on the
  // current screen; the window closes (and maybe emits) on route change or the
  // time cap. `windowStart` is the timestamp the window opened at.
  let durations: number[] = [];
  let windowRoute = '';
  let windowStart = -1;

  let prevTimestamp = -1;
  let rafHandle: number | null = null;
  let disposed = false;

  function resetWindow(): void {
    durations = [];
    windowRoute = '';
    windowStart = -1;
  }

  // Emit one summary for the closing window, then reset. Suppressed entirely
  // when no slow frame occurred (a smooth screen sends nothing) or the window
  // is empty — this is where the volume cut lives.
  function flushWindow(endTimestamp: number): void {
    if (durations.length === 0) {
      resetWindow();
      return;
    }
    let slow = 0;
    let dropped = 0;
    for (const d of durations) {
      if (d >= slowThreshold) slow++;
      if (d >= dropThreshold) dropped++;
    }
    if (slow === 0) {
      resetWindow();
      return;
    }
    try {
      const sorted = [...durations].sort((a, b) => a - b);
      const p95 = percentile(sorted, 0.95);
      const attrs: EventAttributes = {
        frames_total: durations.length,
        slow_frames: slow,
        dropped_frames: dropped,
        p50_ms: percentile(sorted, 0.5),
        p95_ms: p95,
        worst_ms: sorted[sorted.length - 1] ?? 0,
        window_ms: Math.max(0, endTimestamp - windowStart),
        'metric.screen': windowRoute,
      };
      deps.recordMetric('frame_render_time', p95, attrs);
    } catch (err) {
      healthMonitor.reportError('frames.emit', err);
    }
    resetWindow();
  }

  const tick = (timestamp: number): void => {
    if (disposed) return;
    if (prevTimestamp >= 0) {
      const total = Math.max(0, timestamp - prevTimestamp);
      const route = deps.getCurrentRoute();
      // Close the current window before appending when the screen changed or
      // the time cap is hit; the straddling frame belongs to the fresh window.
      if (durations.length > 0 && (route !== windowRoute || timestamp - windowStart >= MAX_WINDOW_MS)) {
        flushWindow(prevTimestamp);
      }
      if (durations.length === 0) {
        windowRoute = route;
        windowStart = prevTimestamp;
      }
      durations.push(total);
    }
    prevTimestamp = timestamp;
    rafHandle = raf(tick);
  };

  rafHandle = raf(tick);

  return {
    dispose: () => {
      // Flush an in-progress window so a screen's jank isn't lost on teardown
      // (disable / session end). Route changes already flush mid-loop.
      flushWindow(prevTimestamp);
      disposed = true;
      if (rafHandle !== null) {
        try {
          cancelRaf(rafHandle);
        } catch (err) {
          healthMonitor.reportError('frames.cancel', err);
        }
        rafHandle = null;
      }
    },
  };
}

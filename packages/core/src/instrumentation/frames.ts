import type { EventAttributes } from '../index';
import { healthMonitor } from '../internal/health';

export interface FramesDeps {
  /** One `frame.summary` (E20) per closed window. */
  record: (attributes: EventAttributes) => void;
  getCurrentRoute: () => string;
  slowThresholdMs?: number;
  /** Subscribes to screen changes; a route change wakes an idle loop (E20). Returns the unsubscribe. */
  onRouteChange?: (f: () => void) => () => void;
  // Test seams
  rafScheduler?: (cb: (timestamp: number) => void) => number;
  rafCanceller?: (handle: number) => void;
  // Where input / Ionic transitions are heard (E20 idle-pause); defaults to `window`.
  activityTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
}

export interface FramesHandle {
  dispose: () => void;
}

// Cordova E20: one missed vsync at 60 Hz is slow; Android vitals' frozen frame.
const DEFAULT_SLOW_THRESHOLD_MS = 34;
const FROZEN_MS = 700;
// A window force-closes after this long so a screen scrolled for minutes
// produces several summaries rather than one coarse blob. Internal constant
// (ADR-030) — no config knob.
const MAX_WINDOW_MS = 30000;
// E20: the loop pauses after this long with no input, scroll, route change or Ionic transition,
// so a static screen costs nothing, and restarts on the next one.
const IDLE_MS = 2000;
const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'scroll', 'touchmove', 'ionViewWillEnter'];
const LISTEN = { capture: true, passive: true };

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

export function registerFrameCapture(deps: FramesDeps): FramesHandle {
  if (!rafAvailable(deps)) {
    return { dispose: () => undefined };
  }

  const slowThreshold = deps.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
  const raf = deps.rafScheduler ?? defaultRafScheduler;
  const cancelRaf = deps.rafCanceller ?? defaultRafCanceller;

  // In-window state: running counts for the current screen; the window closes (and maybe
  // emits) on route change, the time cap, idle or teardown.
  let total = 0;
  let slow = 0;
  let frozen = 0;
  let max = 0;
  let windowMs = 0;
  let longTasks = 0;
  let windowRoute = '';
  let windowStart = -1;

  let prevTimestamp = -1;
  let rafHandle: number | null = null;
  let disposed = false;
  let lastActivity = -1;
  const target = deps.activityTarget ?? (typeof window !== 'undefined' ? window : undefined);
  const onActivity = (): void => {
    lastActivity = -1; // stamped by the next frame, on the rAF clock
    if (rafHandle === null && !disposed) rafHandle = raf(tick);
  };

  // Cordova E20: `frame.long_task_count` only where the WebView reports long tasks.
  let observer: PerformanceObserver | undefined;
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    try {
      observer = new PerformanceObserver((list) => {
        if (total) longTasks += list.getEntries().length;
      });
      observer.observe({ type: 'longtask' });
    } catch (err) {
      healthMonitor.reportError('frames.longtask', err);
    }
  }

  // Emit one summary for the closing window, then reset. Suppressed entirely
  // when no slow frame occurred (a smooth or empty window sends nothing) —
  // this is where the volume cut lives (ADR-030).
  function flushWindow(): void {
    if (slow) {
      try {
        deps.record({
          'screen.name': windowRoute,
          'frame.total_frames': total,
          'frame.slow_frames': slow,
          'frame.frozen_frames': frozen,
          'frame.max_total_duration_ms': Math.round(max),
          'frame.slow_frame_rate': Math.round((slow / total) * 1e4) / 1e4,
          'frame.window_duration_ms': Math.round(windowMs),
          'frame.source': 'raf',
          ...(observer && { 'frame.long_task_count': longTasks }),
        });
        healthMonitor.reportSuccess('frames.emit');
      } catch (err) {
        healthMonitor.reportError('frames.emit', err);
      }
    }
    total = slow = frozen = max = windowMs = longTasks = 0;
    windowStart = -1;
  }

  function tick(timestamp: number): void {
    if (disposed) return;
    if (lastActivity < 0) lastActivity = timestamp;
    if (timestamp - lastActivity >= IDLE_MS) {
      // Idle: close the window and stop asking for frames until something happens.
      flushWindow();
      prevTimestamp = -1;
      rafHandle = null;
      return;
    }
    if (prevTimestamp >= 0) {
      const d = Math.max(0, timestamp - prevTimestamp);
      const route = deps.getCurrentRoute();
      // Close the current window before counting when the screen changed or
      // the time cap is hit; the straddling frame belongs to the fresh window.
      if (total > 0 && (route !== windowRoute || timestamp - windowStart >= MAX_WINDOW_MS)) flushWindow();
      if (total === 0) {
        windowRoute = route;
        windowStart = prevTimestamp;
      }
      total++;
      windowMs += d;
      max = Math.max(max, d);
      if (d >= slowThreshold) slow++;
      if (d >= FROZEN_MS) frozen++;
    }
    prevTimestamp = timestamp;
    rafHandle = raf(tick);
  }

  // Cordova E20: frames only while visible. Hide closes the window; the first frame after
  // showing starts a fresh gap, so hidden time is never a frame.
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      flushWindow();
      prevTimestamp = -1;
    } else onActivity();
  };
  const doc = typeof document !== 'undefined' ? document : undefined;

  for (const type of ACTIVITY) target?.addEventListener(type, onActivity, LISTEN);
  doc?.addEventListener('visibilitychange', onVisibility);
  const offRoute = deps.onRouteChange?.(onActivity);
  rafHandle = raf(tick);

  return {
    dispose: () => {
      // Flush an in-progress window so a screen's jank isn't lost on teardown
      // (disable / session end). Route changes already flush mid-loop.
      flushWindow();
      disposed = true;
      offRoute?.();
      observer?.disconnect();
      for (const type of ACTIVITY) target?.removeEventListener(type, onActivity, LISTEN);
      doc?.removeEventListener('visibilitychange', onVisibility);
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

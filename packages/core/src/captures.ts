import { event, metric, route, type Capture } from './core';
import { registerConsoleErrorCapture } from './instrumentation/errors';
import { registerFrameCapture } from './instrumentation/frames';
import { registerInteractionCapture } from './instrumentation/interactions';
import { registerPerfObserver } from './instrumentation/perf-observer';
import { registerVitalsCapture } from './instrumentation/vitals';

// L2 / C3: each capture is its own import so an app that doesn't list it doesn't ship it.

/** Web Vitals (LCP, INP, CLS, FCP, TTFB). */
export const vitals = (): Capture => ({
  name: 'vitals',
  start: () => registerVitalsCapture({ recordMetric: metric, getCurrentRoute: route }),
});

/** Taps and clicks. */
export const interactions = (): Capture => ({
  name: 'interactions',
  start: () => registerInteractionCapture({ recordEvent: event, getCurrentRoute: route }).dispose,
});

/** Rendering smoothness. `slowThresholdMs`: a frame slower than this counts as slow. */
export const frames = (opts: { slowThresholdMs?: number } = {}): Capture => ({
  name: 'frames',
  start: () => registerFrameCapture({ recordMetric: metric, getCurrentRoute: route, slowThresholdMs: opts.slowThresholdMs }).dispose,
});

/** Main-thread tasks over 50 ms. */
export const longTasks = (): Capture => ({
  name: 'longTasks',
  start: () => registerPerfObserver({ recordMetric: metric, getCurrentRoute: route, resources: false }).dispose,
});

/** Per-screen resource load timings. Off unless listed. */
export const resourceTiming = (): Capture => ({
  name: 'resourceTiming',
  start: () => registerPerfObserver({ recordMetric: metric, getCurrentRoute: route, longTasks: false }).dispose,
});

/** `console.error` lines, kept as context on the next error report. */
export const consoleErrors = (): Capture => ({
  name: 'consoleErrors',
  start: () => registerConsoleErrorCapture({}).dispose,
});

/** The standard set: vitals, interactions, frames, long tasks, console errors. */
export const defaultCaptures = (): Capture[] => [vitals(), interactions(), frames(), longTasks(), consoleErrors()];

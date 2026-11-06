import { event, flush, metric, onRouteChange, record, route, state, type Capture } from './core';
import { registerConsoleErrorCapture } from './instrumentation/errors';
import { registerFrameCapture } from './instrumentation/frames';
import { registerInteractionCapture } from './instrumentation/interactions';
import { registerPerfObserver } from './instrumentation/perf-observer';
import { registerVitalsCapture } from './instrumentation/vitals';
import { breadcrumbs } from './internal/breadcrumbs';
import { interactionRoot } from './traces';

// L2 / C3: each capture is its own import so an app that doesn't list it doesn't ship it.

/** Web Vitals (LCP, INP, CLS, FCP, TTFB). */
export const vitals = (): Capture => ({
  name: 'vitals',
  start: () => registerVitalsCapture({ recordMetric: metric, getCurrentRoute: route, flush }),
});

/** Taps and clicks. */
export const interactions = (): Capture => ({
  name: 'interactions',
  start: () => registerInteractionCapture({
    record: (attributes, timestamp) => record({ type: 'event', eventName: 'ui.interaction', timestamp, attributes }, false),
    // P6: the crumb is left at the tap, so an error the tap causes carries it.
    breadcrumb: (name) => state.enabled && breadcrumbs.push({ ts: new Date().toISOString(), type: 'ui.interaction', name }),
    getCurrentRoute: route,
    mintRoot: interactionRoot,
    activity: () => state.activity,
    flush,
  }).dispose,
});

/** Rendering smoothness. `slowThresholdMs` (default 34): a frame at least this long counts as slow. */
export const frames = (opts: { slowThresholdMs?: number } = {}): Capture => ({
  name: 'frames',
  start: () => registerFrameCapture({
    record: (attributes) => event('frame.summary', attributes),
    getCurrentRoute: route,
    slowThresholdMs: opts.slowThresholdMs,
    onRouteChange,
  }).dispose,
});

/** Main-thread tasks over 50 ms. */
export const longTasks = (): Capture => ({
  name: 'longTasks',
  start: () => registerPerfObserver({ recordMetric: metric, getCurrentRoute: route, resources: false }).dispose,
});

/** Resource load timings, summarised per screen and host. Off unless listed. */
export const resourceTiming = (): Capture => ({
  name: 'resourceTiming',
  start: () => registerPerfObserver({
    recordMetric: metric,
    getCurrentRoute: route,
    longTasks: false,
    onRouteChange,
    // E7: the SDK's own endpoint is never counted (same rule as `http.request`).
    ignoreResourceUrl: (url) => !!state.options.endpoint && url.includes(state.options.endpoint),
  }).dispose,
});

/** `console.error` lines, kept as context on the next error report. */
export const consoleErrors = (): Capture => ({
  name: 'consoleErrors',
  // Consent off keeps nothing, not even crash context.
  start: () => registerConsoleErrorCapture({ pushBreadcrumb: (m) => state.enabled && breadcrumbs.pushConsole(m) }).dispose,
});

/** The standard set: vitals, interactions, frames, long tasks, console errors. */
export const defaultCaptures = (): Capture[] => [vitals(), interactions(), frames(), longTasks(), consoleErrors()];

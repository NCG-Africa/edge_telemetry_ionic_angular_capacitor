import type { EventAttributes } from '../index';
import { healthMonitor } from '../internal/health';

export interface MemoryWebDeps {
  recordMetric: (metricName: string, value: number, attributes: EventAttributes) => void;
  intervalMs?: number;
  // Test seams
  setInterval?: (cb: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  getPerformance?: () => PerformanceMemoryLike | undefined;
}

export interface MemoryWebHandle {
  dispose: () => void;
  sampleNow: () => void;
}

interface PerformanceMemoryReading {
  usedJSHeapSize?: number;
}

interface PerformanceMemoryLike {
  memory?: PerformanceMemoryReading;
}

const DEFAULT_INTERVAL_MS = 10_000;

function defaultGetPerformance(): PerformanceMemoryLike | undefined {
  const g = globalThis as unknown as { performance?: PerformanceMemoryLike };
  return g.performance;
}

function defaultSetInterval(cb: () => void, ms: number): unknown {
  return setInterval(cb, ms);
}

function defaultClearInterval(handle: unknown): void {
  clearInterval(handle as ReturnType<typeof setInterval>);
}

export function registerMemoryWebCapture(deps: MemoryWebDeps): MemoryWebHandle {
  const getPerf = deps.getPerformance ?? defaultGetPerformance;
  const perf = getPerf();
  // `performance.memory` is Chromium-only. Skip silently elsewhere — no event
  // and no health-monitor noise; the Capacitor native sampler covers iOS/Android.
  if (!perf || !perf.memory || typeof perf.memory.usedJSHeapSize !== 'number') {
    return { dispose: () => undefined, sampleNow: () => undefined };
  }

  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const intervalSetter = deps.setInterval ?? defaultSetInterval;
  const intervalClearer = deps.clearInterval ?? defaultClearInterval;

  const sample = (): void => {
    try {
      const current = getPerf();
      const used = current?.memory?.usedJSHeapSize;
      if (typeof used !== 'number' || !Number.isFinite(used)) return;
      const mb = used / (1024 * 1024);
      deps.recordMetric('memory_usage', mb, {
        unit: 'MB',
        memory_type: 'heap',
        memory_source: 'javascript',
      });
    } catch (err) {
      healthMonitor.reportError('memory-web.emit', err);
    }
  };

  // Take an initial sample so consumers see a baseline before the first
  // interval fires — the first foreground would otherwise wait `intervalMs`
  // before producing any data.
  sample();

  const handle = intervalSetter(sample, intervalMs);

  return {
    dispose: () => intervalClearer(handle),
    sampleNow: sample,
  };
}

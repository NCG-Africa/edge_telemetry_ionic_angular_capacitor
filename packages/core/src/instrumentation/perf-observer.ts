import type { EventAttributes } from '../index';
import { healthMonitor } from '../internal/health';

export interface PerfObserverDeps {
  recordMetric: (metricName: string, value: number, attributes: EventAttributes) => void;
  getCurrentRoute: () => string;
  ignoreResourceUrl?: (url: string) => boolean;
}

export interface PerfObserverHandle {
  dispose: () => void;
}

type ObserverLike = {
  observe: (options: { entryTypes?: string[]; type?: string; buffered?: boolean }) => void;
  disconnect: () => void;
};

interface ResourceEntryLike extends PerformanceEntry {
  initiatorType?: string;
  transferSize?: number;
  encodedBodySize?: number;
}

function getPerformanceObserverCtor(): (new (cb: (list: PerformanceObserverEntryList) => void) => ObserverLike) | undefined {
  const g = globalThis as unknown as { PerformanceObserver?: new (cb: (list: PerformanceObserverEntryList) => void) => ObserverLike };
  return g.PerformanceObserver;
}

function supportsType(type: string): boolean {
  const Ctor = getPerformanceObserverCtor() as unknown as { supportedEntryTypes?: string[] };
  return Array.isArray(Ctor?.supportedEntryTypes) && Ctor.supportedEntryTypes.includes(type);
}

export function registerPerfObserver(deps: PerfObserverDeps): PerfObserverHandle {
  const Ctor = getPerformanceObserverCtor();
  if (!Ctor) {
    return { dispose: () => undefined };
  }

  const observers: ObserverLike[] = [];

  // Long tasks
  if (supportsType('longtask')) {
    try {
      const obs = new Ctor((list) => {
        for (const entry of list.getEntries()) {
          try {
            deps.recordMetric('long_task', entry.duration, {
              'metric.unit': 'ms',
              'metric.name': entry.name || 'self',
              'metric.screen': deps.getCurrentRoute(),
            });
            healthMonitor.reportSuccess('perf-observer.longtask.emit');
          } catch (err) {
            healthMonitor.reportError('perf-observer.longtask.emit', err);
          }
        }
      });
      obs.observe({ type: 'longtask', buffered: true });
      observers.push(obs);
    } catch (err) {
      healthMonitor.reportError('perf-observer.longtask.setup', err);
    }
  }

  // Resource timing
  if (supportsType('resource')) {
    try {
      const obs = new Ctor((list) => {
        for (const entry of list.getEntries() as ResourceEntryLike[]) {
          try {
            const url = entry.name ?? '';
            if (deps.ignoreResourceUrl && deps.ignoreResourceUrl(url)) continue;
            const attrs: EventAttributes = {
              'metric.unit': 'ms',
              'metric.resource_name': url,
              'metric.resource_type': entry.initiatorType ?? 'unknown',
              'metric.screen': deps.getCurrentRoute(),
            };
            if (typeof entry.transferSize === 'number' && Number.isFinite(entry.transferSize)) {
              attrs['metric.transfer_size'] = entry.transferSize;
            }
            deps.recordMetric('resource_timing', entry.duration, attrs);
            healthMonitor.reportSuccess('perf-observer.resource.emit');
          } catch (err) {
            healthMonitor.reportError('perf-observer.resource.emit', err);
          }
        }
      });
      obs.observe({ type: 'resource', buffered: true });
      observers.push(obs);
    } catch (err) {
      healthMonitor.reportError('perf-observer.resource.setup', err);
    }
  }

  return {
    dispose: () => {
      for (const obs of observers) {
        try {
          obs.disconnect();
        } catch (err) {
          healthMonitor.reportError('perf-observer.dispose', err);
        }
      }
    },
  };
}

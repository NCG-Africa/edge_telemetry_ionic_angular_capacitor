import type { EventAttributes } from '../index';
import { healthMonitor } from '../internal/health';
import { isProxyUrl, parseUrl, templateUrl } from './url-sanitizer';

export interface PerfObserverDeps {
  recordMetric: (metricName: string, value: number, attributes: EventAttributes) => void;
  getCurrentRoute: () => string;
  ignoreResourceUrl?: (url: string) => boolean;
  // Both default on; `longTasks()` and `resourceTiming()` each turn on one.
  longTasks?: boolean;
  resources?: boolean;
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
  if (deps.longTasks !== false && supportsType('longtask')) {
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

  // E7: resource timing, aggregated per screen window by templated host + initiator type.
  // No per-resource URLs leave the device; CapacitorHttp proxy loads are the bridge, not the app.
  const groups = new Map<string, { host: string; type: string; durations: number[]; bytes: number }>();
  let windowRoute = '';
  const flushResources = (): void => {
    for (const g of groups.values()) {
      try {
        const sorted = g.durations.sort((a, b) => a - b);
        const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] ?? 0;
        deps.recordMetric('resource_timing', p95, {
          'metric.unit': 'ms',
          'metric.screen': windowRoute,
          'resource.host': g.host,
          'resource.initiator_type': g.type,
          'resource.count': sorted.length,
          'resource.p95_ms': p95,
          'resource.transfer_kb': Math.round(g.bytes / 102.4) / 10,
        });
        healthMonitor.reportSuccess('perf-observer.resource.emit');
      } catch (err) {
        healthMonitor.reportError('perf-observer.resource.emit', err);
      }
    }
    groups.clear();
  };
  const onHidden = (): void => {
    if (document.visibilityState === 'hidden') flushResources();
  };
  if (deps.resources !== false && supportsType('resource')) {
    try {
      const obs = new Ctor((list) => {
        const route = deps.getCurrentRoute();
        // ponytail: the window closes on the first entry after a screen change, on hide or on dispose.
        if (route !== windowRoute) flushResources();
        windowRoute = route;
        for (const entry of list.getEntries() as ResourceEntryLike[]) {
          const url = entry.name ?? '';
          if (isProxyUrl(url) || deps.ignoreResourceUrl?.(url)) continue;
          const u = parseUrl(templateUrl(url));
          const host = u?.host || u?.protocol || 'unknown';
          const type = entry.initiatorType || 'unknown';
          const key = `${host} ${type}`;
          const g = groups.get(key) ?? { host, type, durations: [], bytes: 0 };
          groups.set(key, g);
          g.durations.push(entry.duration);
          if (Number.isFinite(entry.transferSize)) g.bytes += entry.transferSize ?? 0;
        }
      });
      obs.observe({ type: 'resource', buffered: true });
      observers.push(obs);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onHidden);
    } catch (err) {
      healthMonitor.reportError('perf-observer.resource.setup', err);
    }
  }

  return {
    dispose: () => {
      flushResources();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onHidden);
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

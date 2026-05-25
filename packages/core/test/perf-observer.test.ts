import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerPerfObserver } from '../src/instrumentation/perf-observer';
import { healthMonitor } from '../src/internal/health';

interface FakeObserver {
  observe: (opts: { type?: string; entryTypes?: string[]; buffered?: boolean }) => void;
  disconnect: () => void;
  emit: (entries: unknown[]) => void;
  observed: Array<{ type?: string; entryTypes?: string[]; buffered?: boolean }>;
  disconnected: boolean;
}

interface ObserverCtor {
  (callback: (list: { getEntries: () => unknown[] }) => void): FakeObserver;
  supportedEntryTypes?: string[];
}

function makeObserverFactory(supported: string[] = ['longtask', 'resource']): {
  ctor: ObserverCtor;
  instances: FakeObserver[];
} {
  const instances: FakeObserver[] = [];
  const ctor = function (
    callback: (list: { getEntries: () => unknown[] }) => void,
  ): FakeObserver {
    const obs: FakeObserver = {
      observed: [],
      disconnected: false,
      observe: (opts) => {
        obs.observed.push(opts);
      },
      disconnect: () => {
        obs.disconnected = true;
      },
      emit: (entries) => {
        callback({ getEntries: () => entries });
      },
    };
    instances.push(obs);
    return obs;
  } as unknown as ObserverCtor;
  ctor.supportedEntryTypes = supported;
  return { ctor, instances };
}

describe('registerPerfObserver', () => {
  const g = globalThis as unknown as { PerformanceObserver?: unknown };
  let original: unknown;

  beforeEach(() => {
    original = g.PerformanceObserver;
    healthMonitor.reset();
  });

  afterEach(() => {
    if (original === undefined) {
      delete g.PerformanceObserver;
    } else {
      g.PerformanceObserver = original;
    }
    vi.restoreAllMocks();
  });

  it('returns a no-op handle when PerformanceObserver is unavailable', () => {
    delete g.PerformanceObserver;
    const recorded: Array<{ name: string; value: number }> = [];
    const handle = registerPerfObserver({
      recordMetric: (name, value) => recorded.push({ name, value }),
      getCurrentRoute: () => '/',
    });
    expect(typeof handle.dispose).toBe('function');
    expect(recorded).toHaveLength(0);
  });

  it('subscribes to longtask + resource when both supported', () => {
    const { ctor, instances } = makeObserverFactory(['longtask', 'resource']);
    g.PerformanceObserver = ctor;

    registerPerfObserver({
      recordMetric: () => undefined,
      getCurrentRoute: () => '/home',
    });

    expect(instances).toHaveLength(2);
    expect(instances[0]!.observed[0]).toEqual({ type: 'longtask', buffered: true });
    expect(instances[1]!.observed[0]).toEqual({ type: 'resource', buffered: true });
  });

  it('emits long_task metric for each longtask entry', () => {
    const { ctor, instances } = makeObserverFactory(['longtask']);
    g.PerformanceObserver = ctor;

    const recorded: Array<{ name: string; value: number; attrs: Record<string, unknown> }> = [];
    registerPerfObserver({
      recordMetric: (name, value, attrs) => recorded.push({ name, value, attrs }),
      getCurrentRoute: () => '/products/42',
    });

    instances[0]!.emit([
      { duration: 78, name: 'self' },
      { duration: 142, name: 'cross-origin-descendant' },
    ]);

    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.name).toBe('long_task');
    expect(recorded[0]!.value).toBe(78);
    expect(recorded[0]!.attrs['metric.unit']).toBe('ms');
    expect(recorded[0]!.attrs['metric.name']).toBe('self');
    expect(recorded[0]!.attrs['metric.screen']).toBe('/products/42');
    expect(recorded[1]!.value).toBe(142);
    expect(recorded[1]!.attrs['metric.name']).toBe('cross-origin-descendant');
  });

  it('emits resource_timing metric for each resource entry', () => {
    const { ctor, instances } = makeObserverFactory(['resource']);
    g.PerformanceObserver = ctor;

    const recorded: Array<{ name: string; value: number; attrs: Record<string, unknown> }> = [];
    registerPerfObserver({
      recordMetric: (name, value, attrs) => recorded.push({ name, value, attrs }),
      getCurrentRoute: () => '/home',
    });

    instances[0]!.emit([
      { duration: 234, name: 'https://cdn.example.com/img.png', initiatorType: 'img', transferSize: 41023 },
      { duration: 67, name: 'https://api.example.com/data', initiatorType: 'fetch', transferSize: 1024 },
    ]);

    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.name).toBe('resource_timing');
    expect(recorded[0]!.value).toBe(234);
    expect(recorded[0]!.attrs['metric.unit']).toBe('ms');
    expect(recorded[0]!.attrs['metric.resource_name']).toBe('https://cdn.example.com/img.png');
    expect(recorded[0]!.attrs['metric.resource_type']).toBe('img');
    expect(recorded[0]!.attrs['metric.transfer_size']).toBe(41023);
    expect(recorded[0]!.attrs['metric.screen']).toBe('/home');
    expect(recorded[1]!.attrs['metric.resource_type']).toBe('fetch');
  });

  it('skips resource entries whose URL matches ignoreResourceUrl', () => {
    const { ctor, instances } = makeObserverFactory(['resource']);
    g.PerformanceObserver = ctor;

    const recorded: Array<{ name: string; value: number }> = [];
    registerPerfObserver({
      recordMetric: (name, value) => recorded.push({ name, value }),
      getCurrentRoute: () => '/',
      ignoreResourceUrl: (url) => url.includes('/collector/telemetry'),
    });

    instances[0]!.emit([
      { duration: 50, name: 'https://my-collector.com/collector/telemetry', initiatorType: 'fetch' },
      { duration: 80, name: 'https://api.example.com/users', initiatorType: 'fetch' },
    ]);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.value).toBe(80);
  });

  it('omits metric.transfer_size when the resource entry has no transferSize', () => {
    const { ctor, instances } = makeObserverFactory(['resource']);
    g.PerformanceObserver = ctor;

    const recorded: Array<{ attrs: Record<string, unknown> }> = [];
    registerPerfObserver({
      recordMetric: (_name, _value, attrs) => recorded.push({ attrs }),
      getCurrentRoute: () => '/',
    });

    instances[0]!.emit([{ duration: 12, name: 'about:blank', initiatorType: 'navigation' }]);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.attrs).not.toHaveProperty('metric.transfer_size');
  });

  it('falls back to "unknown" initiatorType when missing', () => {
    const { ctor, instances } = makeObserverFactory(['resource']);
    g.PerformanceObserver = ctor;

    const recorded: Array<{ attrs: Record<string, unknown> }> = [];
    registerPerfObserver({
      recordMetric: (_name, _value, attrs) => recorded.push({ attrs }),
      getCurrentRoute: () => '/',
    });

    instances[0]!.emit([{ duration: 10, name: 'x' }]);

    expect(recorded[0]!.attrs['metric.resource_type']).toBe('unknown');
  });

  it('only subscribes to types listed in supportedEntryTypes', () => {
    const { ctor, instances } = makeObserverFactory(['longtask']); // resource not supported
    g.PerformanceObserver = ctor;

    registerPerfObserver({
      recordMetric: () => undefined,
      getCurrentRoute: () => '/',
    });

    expect(instances).toHaveLength(1);
    expect(instances[0]!.observed[0]?.type).toBe('longtask');
  });

  it('routes setup failures through healthMonitor (does not throw)', () => {
    const failing: ObserverCtor = function () {
      throw new Error('observe-failure');
    } as unknown as ObserverCtor;
    failing.supportedEntryTypes = ['longtask', 'resource'];
    g.PerformanceObserver = failing;

    expect(() =>
      registerPerfObserver({
        recordMetric: () => undefined,
        getCurrentRoute: () => '/',
      }),
    ).not.toThrow();
    expect(healthMonitor.getErrorCount()).toBeGreaterThan(0);
  });

  it('routes per-entry emit errors through healthMonitor', () => {
    const { ctor, instances } = makeObserverFactory(['longtask']);
    g.PerformanceObserver = ctor;

    registerPerfObserver({
      recordMetric: () => {
        throw new Error('boom');
      },
      getCurrentRoute: () => '/',
    });

    expect(() => instances[0]!.emit([{ duration: 60, name: 'self' }])).not.toThrow();
    expect(healthMonitor.getErrorCount()).toBeGreaterThan(0);
  });

  it('dispose() disconnects all observers', () => {
    const { ctor, instances } = makeObserverFactory(['longtask', 'resource']);
    g.PerformanceObserver = ctor;

    const handle = registerPerfObserver({
      recordMetric: () => undefined,
      getCurrentRoute: () => '/',
    });
    handle.dispose();

    expect(instances[0]!.disconnected).toBe(true);
    expect(instances[1]!.disconnected).toBe(true);
  });
});

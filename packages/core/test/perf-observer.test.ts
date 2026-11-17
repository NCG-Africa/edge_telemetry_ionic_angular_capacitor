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
    expect(recorded[0]!.name).toBe('perf.long_task');
    expect(recorded[0]!.value).toBe(78);
    expect(recorded[0]!.attrs['metric.unit']).toBe('ms');
    expect(recorded[0]!.attrs['metric.name']).toBe('self');
    expect(recorded[0]!.attrs['screen.name']).toBe('/products/42');
    expect(recorded[1]!.value).toBe(142);
    expect(recorded[1]!.attrs['metric.name']).toBe('cross-origin-descendant');
  });

  function resources() {
    const { ctor, instances } = makeObserverFactory(['resource']);
    g.PerformanceObserver = ctor;
    const recorded: Array<{ name: string; value: number; attrs: Record<string, unknown> }> = [];
    const route = { current: '/home', listeners: new Set<() => void>() };
    const handle = registerPerfObserver({
      recordMetric: (name, value, attrs) => recorded.push({ name, value, attrs }),
      getCurrentRoute: () => route.current,
      onRouteChange: (f) => {
        route.listeners.add(f);
        return () => route.listeners.delete(f);
      },
      ignoreResourceUrl: (url) => url.startsWith('https://ingest.example.com'),
    });
    const navigate = (to: string) => {
      for (const f of route.listeners) f();
      route.current = to;
    };
    // One observer per test; its absence is a test bug.
    return { emit: (e: unknown[]) => instances[0]!.emit(e), recorded, handle, navigate, route };
  }

  it('aggregates resource_timing per screen window by host and initiator type (E7)', () => {
    const r = resources();
    r.emit([
      { duration: 100, name: 'https://cdn.example.com/img/1.png', initiatorType: 'img', transferSize: 2048 },
      { duration: 300, name: 'https://cdn.example.com/img/2.png?sig=x', initiatorType: 'img', transferSize: 1024 },
      { duration: 50, name: 'https://api.example.com/users/42', initiatorType: 'fetch', transferSize: 512 },
    ]);
    expect(r.recorded).toHaveLength(0);
    // The window closes on the screen change itself, not on the next entry.
    r.navigate('/cart');
    expect(r.recorded).toHaveLength(2);
    r.emit([{ duration: 10, name: 'https://cdn.example.com/a.js', initiatorType: 'script' }]);

    expect(r.recorded).toEqual([
      { name: 'perf.resource_timing', value: 300, attrs: {
        'metric.unit': 'ms', 'screen.name': '/home', 'resource.host': 'cdn.example.com',
        'resource.initiator_type': 'img', 'resource.count': 2, 'resource.p95_ms': 300, 'resource.transfer_kb': 3,
      } },
      { name: 'perf.resource_timing', value: 50, attrs: {
        'metric.unit': 'ms', 'screen.name': '/home', 'resource.host': 'api.example.com',
        'resource.initiator_type': 'fetch', 'resource.count': 1, 'resource.p95_ms': 50, 'resource.transfer_kb': 0.5,
      } },
    ]);
    expect(JSON.stringify(r.recorded)).not.toContain('png');

    r.handle.dispose();
    expect(r.recorded).toHaveLength(3);
    expect(r.route.listeners.size).toBe(0);
    expect(r.recorded[2]?.attrs).toMatchObject({ 'screen.name': '/cart', 'resource.initiator_type': 'script', 'resource.transfer_kb': 0 });
  });

  it('excludes CapacitorHttp proxy loads and ignored URLs (the SDK endpoint)', () => {
    const r = resources();
    r.emit([
      { duration: 50, name: `capacitor://localhost/_capacitor_http_interceptor_?u=${encodeURIComponent('https://api.example.com/x')}`, initiatorType: 'fetch' },
      { duration: 60, name: 'https://ingest.example.com/collector', initiatorType: 'fetch' },
    ]);
    r.handle.dispose();

    expect(r.recorded).toHaveLength(0);
  });

  it('falls back to "unknown" initiatorType when missing', () => {
    const r = resources();
    r.emit([{ duration: 10, name: 'https://a.example.com/x' }]);
    r.handle.dispose();

    expect(r.recorded[0]?.attrs['resource.initiator_type']).toBe('unknown');
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

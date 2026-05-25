import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MetricCallback = (metric: {
  name: 'CLS' | 'FCP' | 'FID' | 'INP' | 'LCP' | 'TTFB';
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  delta: number;
  id: string;
  entries: PerformanceEntry[];
  navigationType: 'navigate' | 'reload' | 'back-forward' | 'back-forward-cache' | 'prerender' | 'restore';
}) => void;

const callbacks: Record<string, MetricCallback | undefined> = {};

vi.mock('web-vitals', () => ({
  onLCP: (cb: MetricCallback) => {
    callbacks.LCP = cb;
  },
  onINP: (cb: MetricCallback) => {
    callbacks.INP = cb;
  },
  onCLS: (cb: MetricCallback) => {
    callbacks.CLS = cb;
  },
  onFCP: (cb: MetricCallback) => {
    callbacks.FCP = cb;
  },
  onTTFB: (cb: MetricCallback) => {
    callbacks.TTFB = cb;
  },
}));

import { registerVitalsCapture } from '../src/instrumentation/vitals';

type RecordedMetric = {
  metricName: string;
  value: number;
  attributes: Record<string, string | number | boolean>;
};

type MetricName = 'CLS' | 'FCP' | 'FID' | 'INP' | 'LCP' | 'TTFB';

function baseMetric(name: MetricName) {
  return {
    name,
    value: 0,
    rating: 'good' as const,
    delta: 0,
    id: 'abc',
    entries: [] as PerformanceEntry[],
    navigationType: 'navigate' as const,
  };
}

describe('registerVitalsCapture', () => {
  let recorded: RecordedMetric[];
  let currentRoute: string;

  beforeEach(() => {
    recorded = [];
    currentRoute = '/home';
    for (const key of Object.keys(callbacks)) delete callbacks[key];

    registerVitalsCapture({
      recordMetric: (metricName, value, attributes) => {
        recorded.push({ metricName, value, attributes: { ...attributes } });
      },
      getCurrentRoute: () => currentRoute,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('subscribes to all five supported vitals', () => {
    expect(callbacks.LCP).toBeTypeOf('function');
    expect(callbacks.INP).toBeTypeOf('function');
    expect(callbacks.CLS).toBeTypeOf('function');
    expect(callbacks.FCP).toBeTypeOf('function');
    expect(callbacks.TTFB).toBeTypeOf('function');
  });

  it('emits a metric (not an event) when LCP fires', () => {
    callbacks.LCP!({ ...baseMetric('LCP'), value: 1240, rating: 'good' });

    expect(recorded).toHaveLength(1);
    const m = recorded[0]!;
    expect(m.metricName).toBe('LCP');
    expect(m.value).toBe(1240);
    expect(m.attributes['metric.unit']).toBe('ms');
    expect(m.attributes['metric.rating']).toBe('good');
    expect(m.attributes['metric.screen']).toBe('/home');
  });

  it('does not use the legacy performance.* attribute keys', () => {
    callbacks.FCP!({ ...baseMetric('FCP'), value: 670, rating: 'good' });
    const attrs = recorded[0]!.attributes;
    expect(attrs).not.toHaveProperty('performance.metric_name');
    expect(attrs).not.toHaveProperty('performance.value');
    expect(attrs).not.toHaveProperty('performance.unit');
    expect(attrs).not.toHaveProperty('performance.rating');
    expect(attrs).not.toHaveProperty('performance.screen');
  });

  it.each([
    ['LCP', 'ms'],
    ['INP', 'ms'],
    ['FCP', 'ms'],
    ['TTFB', 'ms'],
    ['CLS', 'score'],
  ] as const)('uses correct unit for %s → %s', (name, unit) => {
    callbacks[name]!({ ...baseMetric(name), value: 10 });
    expect(recorded[0]!.attributes['metric.unit']).toBe(unit);
    expect(recorded[0]!.metricName).toBe(name);
  });

  it('metricName is always one of the five supported values', () => {
    for (const name of ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const) {
      callbacks[name]!({ ...baseMetric(name) });
    }
    const names = recorded.map((m) => m.metricName);
    expect(new Set(names)).toEqual(new Set(['LCP', 'INP', 'CLS', 'FCP', 'TTFB']));
  });

  it.each(['good', 'needs-improvement', 'poor'] as const)(
    'propagates rating "%s" unchanged',
    (rating) => {
      callbacks.LCP!({ ...baseMetric('LCP'), rating });
      expect(recorded[0]!.attributes['metric.rating']).toBe(rating);
    },
  );

  it('metric.screen reflects the current route at emit time', () => {
    currentRoute = '/products/42';
    callbacks.INP!({ ...baseMetric('INP'), value: 80 });
    expect(recorded[0]!.attributes['metric.screen']).toBe('/products/42');

    currentRoute = '/cart';
    callbacks.LCP!({ ...baseMetric('LCP'), value: 800 });
    expect(recorded[1]!.attributes['metric.screen']).toBe('/cart');
  });

  it('all attribute values are primitives (string | number | boolean)', () => {
    callbacks.CLS!({ ...baseMetric('CLS'), value: 0.12, rating: 'needs-improvement' });
    for (const v of Object.values(recorded[0]!.attributes)) {
      expect(['string', 'number', 'boolean']).toContain(typeof v);
    }
  });

  it('emitted payload contains no OTel identifiers', () => {
    callbacks.LCP!({ ...baseMetric('LCP'), value: 1000 });
    const json = JSON.stringify(recorded[0]);
    expect(json).not.toMatch(/traceId/i);
    expect(json).not.toMatch(/spanId/i);
    expect(json).not.toMatch(/resourceSpans/i);
    expect(json).not.toMatch(/instrumentationScope/i);
    expect(json).not.toMatch(/opentelemetry/i);
  });

  it('swallows errors thrown by recordMetric and does not propagate to web-vitals callback', () => {
    recorded = [];
    for (const key of Object.keys(callbacks)) delete callbacks[key];

    registerVitalsCapture({
      recordMetric: () => {
        throw new Error('transport exploded');
      },
      getCurrentRoute: () => '/x',
    });

    expect(() => callbacks.LCP!({ ...baseMetric('LCP'), value: 1 })).not.toThrow();
  });

  it('swallows errors thrown by getCurrentRoute', () => {
    for (const key of Object.keys(callbacks)) delete callbacks[key];

    registerVitalsCapture({
      recordMetric: (metricName, value, attrs) => {
        recorded.push({ metricName, value, attributes: { ...attrs } });
      },
      getCurrentRoute: () => {
        throw new Error('no route yet');
      },
    });

    expect(() => callbacks.CLS!({ ...baseMetric('CLS'), value: 0.05 })).not.toThrow();
  });
});

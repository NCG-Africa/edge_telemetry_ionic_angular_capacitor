import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerPageLoadCapture } from '../src/instrumentation/pageload';

type RecordedEvent = {
  eventName: 'page_load';
  attributes: Record<string, string | number | boolean>;
};

type Listener = (event: Event) => void;

class FakeWindow {
  listeners: Record<string, Listener[]> = {};
  document = { readyState: 'loading' as DocumentReadyState };

  addEventListener = (type: string, listener: Listener): void => {
    (this.listeners[type] ||= []).push(listener);
  };

  removeEventListener = (type: string, listener: Listener): void => {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener);
  };

  fire(type: string): void {
    for (const l of this.listeners[type] ?? []) l(new Event(type));
  }
}

function makeNavigationEntry(over: Partial<PerformanceNavigationTiming> = {}): PerformanceNavigationTiming {
  return {
    name: 'https://example.test/',
    entryType: 'navigation',
    startTime: 0,
    duration: 980,
    requestStart: 100,
    responseStart: 280,
    domContentLoadedEventEnd: 420,
    loadEventEnd: 980,
    ...over,
  } as unknown as PerformanceNavigationTiming;
}

function makePerf(nav?: PerformanceNavigationTiming, resourceCount = 24): Performance {
  return {
    getEntriesByType: (type: string) => {
      if (type === 'navigation') return nav ? [nav] : [];
      if (type === 'resource') return new Array(resourceCount).fill({}) as PerformanceEntry[];
      return [];
    },
  } as unknown as Performance;
}

describe('registerPageLoadCapture', () => {
  let win: FakeWindow;
  let recorded: RecordedEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    win = new FakeWindow();
    recorded = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function register(opts: { nav?: PerformanceNavigationTiming; resourceCount?: number; route?: string } = {}) {
    return registerPageLoadCapture({
      recordEvent: (eventName, attributes) => recorded.push({ eventName, attributes: { ...attributes } }),
      target: win as unknown as Window,
      getPerformance: () => makePerf(opts.nav ?? makeNavigationEntry(), opts.resourceCount ?? 24),
      getRoute: () => opts.route ?? '/home',
    });
  }

  it('emits a page_load event with numeric timings when the load event fires', () => {
    register();
    win.fire('load');
    vi.runAllTimers();

    expect(recorded).toHaveLength(1);
    const event = recorded[0]!;
    expect(event.eventName).toBe('page_load');
    expect(event.attributes['page.ttfb_ms']).toBe(180);
    expect(event.attributes['page.dom_content_loaded_ms']).toBe(420);
    expect(event.attributes['page.load_duration_ms']).toBe(980);
    expect(event.attributes['page.resource_count']).toBe(24);
    expect(event.attributes['page.route']).toBe('/home');
  });

  it('timing fields are numbers', () => {
    register();
    win.fire('load');
    vi.runAllTimers();
    const attrs = recorded[0]!.attributes;
    expect(typeof attrs['page.ttfb_ms']).toBe('number');
    expect(typeof attrs['page.dom_content_loaded_ms']).toBe('number');
    expect(typeof attrs['page.load_duration_ms']).toBe('number');
    expect(typeof attrs['page.resource_count']).toBe('number');
  });

  it('all attribute values are primitives (string | number | boolean) — no nested objects', () => {
    register();
    win.fire('load');
    vi.runAllTimers();
    for (const v of Object.values(recorded[0]!.attributes)) {
      expect(['string', 'number', 'boolean']).toContain(typeof v);
      expect(v).not.toBeNull();
      expect(Array.isArray(v)).toBe(false);
    }
  });

  it('emits once even if load fires multiple times', () => {
    register();
    win.fire('load');
    win.fire('load');
    vi.runAllTimers();
    expect(recorded).toHaveLength(1);
  });

  it('fires immediately when document.readyState is already "complete"', () => {
    win.document.readyState = 'complete';
    register();
    vi.runAllTimers();
    expect(recorded).toHaveLength(1);
  });

  it('does not emit when no navigation timing entry is available', () => {
    registerPageLoadCapture({
      recordEvent: (eventName, attributes) => recorded.push({ eventName, attributes: { ...attributes } }),
      target: win as unknown as Window,
      getPerformance: () => makePerf(undefined),
      getRoute: () => '/x',
    });
    win.fire('load');
    vi.runAllTimers();
    expect(recorded).toHaveLength(0);
  });

  it('clamps negative timing diffs to 0', () => {
    register({
      nav: makeNavigationEntry({
        requestStart: 500,
        responseStart: 200,
        startTime: 1000,
        domContentLoadedEventEnd: 500,
        loadEventEnd: 400,
      } as Partial<PerformanceNavigationTiming>),
    });
    win.fire('load');
    vi.runAllTimers();
    const attrs = recorded[0]!.attributes;
    expect(attrs['page.ttfb_ms']).toBe(0);
    expect(attrs['page.dom_content_loaded_ms']).toBe(0);
    expect(attrs['page.load_duration_ms']).toBe(0);
  });

  it('swallows errors thrown by recordEvent', () => {
    registerPageLoadCapture({
      recordEvent: () => {
        throw new Error('transport exploded');
      },
      target: win as unknown as Window,
      getPerformance: () => makePerf(makeNavigationEntry()),
      getRoute: () => '/x',
    });
    expect(() => {
      win.fire('load');
      vi.runAllTimers();
    }).not.toThrow();
  });

  it('swallows errors thrown by getRoute', () => {
    registerPageLoadCapture({
      recordEvent: (eventName, attributes) => recorded.push({ eventName, attributes: { ...attributes } }),
      target: win as unknown as Window,
      getPerformance: () => makePerf(makeNavigationEntry()),
      getRoute: () => {
        throw new Error('no route');
      },
    });
    win.fire('load');
    vi.runAllTimers();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.attributes['page.route']).toBe('/');
  });

  it('swallows errors thrown by getPerformance', () => {
    registerPageLoadCapture({
      recordEvent: (eventName, attributes) => recorded.push({ eventName, attributes: { ...attributes } }),
      target: win as unknown as Window,
      getPerformance: () => {
        throw new Error('perf gone');
      },
      getRoute: () => '/x',
    });
    expect(() => {
      win.fire('load');
      vi.runAllTimers();
    }).not.toThrow();
    expect(recorded).toHaveLength(0);
  });

  it('dispose removes the load listener', () => {
    const handle = register();
    handle.dispose();
    win.fire('load');
    vi.runAllTimers();
    expect(recorded).toHaveLength(0);
  });

  it('resource_count reflects the number of resource entries', () => {
    register({ resourceCount: 7 });
    win.fire('load');
    vi.runAllTimers();
    expect(recorded[0]!.attributes['page.resource_count']).toBe(7);
  });

  it('emitted payload contains no OTel identifiers', () => {
    register();
    win.fire('load');
    vi.runAllTimers();
    const json = JSON.stringify(recorded[0]);
    expect(json).not.toMatch(/traceId/i);
    expect(json).not.toMatch(/spanId/i);
    expect(json).not.toMatch(/resourceSpans/i);
    expect(json).not.toMatch(/instrumentationScope/i);
    expect(json).not.toMatch(/opentelemetry/i);
  });

  it('returns a no-op handle when no target is available', () => {
    const handle = registerPageLoadCapture({
      recordEvent: () => recorded.push({ eventName: 'page_load', attributes: {} as never }),
      target: undefined,
      getPerformance: () => makePerf(makeNavigationEntry()),
    });
    expect(() => handle.dispose()).not.toThrow();
    expect(recorded).toHaveLength(0);
  });
});

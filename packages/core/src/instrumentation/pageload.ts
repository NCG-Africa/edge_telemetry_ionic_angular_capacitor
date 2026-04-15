export type PageLoadEventAttributes = {
  'page.ttfb_ms': number;
  'page.dom_content_loaded_ms': number;
  'page.load_duration_ms': number;
  'page.resource_count': number;
  'page.route': string;
};

export interface PageLoadDeps {
  recordEvent: (eventName: 'page_load', attributes: PageLoadEventAttributes) => void;
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  getPerformance?: () => Performance | undefined;
  getRoute?: () => string;
}

export interface PageLoadHandle {
  dispose: () => void;
}

function nonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function buildAttributes(perf: Performance, route: string): PageLoadEventAttributes | undefined {
  const entries = perf.getEntriesByType('navigation') as PerformanceNavigationTiming[];
  const timing = entries[0];
  if (!timing) return undefined;

  const resources = perf.getEntriesByType('resource');

  return {
    'page.ttfb_ms': nonNegative(timing.responseStart - timing.requestStart),
    'page.dom_content_loaded_ms': nonNegative(timing.domContentLoadedEventEnd - timing.startTime),
    'page.load_duration_ms': nonNegative(timing.loadEventEnd - timing.startTime),
    'page.resource_count': resources.length,
    'page.route': route,
  };
}

export function registerPageLoadCapture(deps: PageLoadDeps): PageLoadHandle {
  const target = deps.target ?? (typeof window !== 'undefined' ? window : undefined);
  const getPerformance =
    deps.getPerformance ??
    (() => (typeof performance !== 'undefined' ? performance : undefined));
  const getRoute =
    deps.getRoute ??
    (() => (typeof window !== 'undefined' ? window.location.pathname : '/'));

  if (!target) {
    return { dispose: () => undefined };
  }

  let emitted = false;

  const emit = (): void => {
    if (emitted) return;
    try {
      const perf = getPerformance();
      if (!perf) return;
      let route = '/';
      try {
        route = getRoute();
      } catch {
        route = '/';
      }
      const attributes = buildAttributes(perf, route);
      if (!attributes) return;
      emitted = true;
      deps.recordEvent('page_load', attributes);
    } catch {
      // Never let capture errors escape.
    }
  };

  const onLoad = (): void => {
    // Defer one task so loadEventEnd is finalised.
    try {
      setTimeout(emit, 0);
    } catch {
      emit();
    }
  };

  const doc = (target as unknown as { document?: Document }).document;
  if (doc && doc.readyState === 'complete') {
    onLoad();
  } else {
    target.addEventListener('load', onLoad as EventListener);
  }

  return {
    dispose: () => {
      try {
        target.removeEventListener('load', onLoad as EventListener);
      } catch {
        // ignore
      }
    },
  };
}

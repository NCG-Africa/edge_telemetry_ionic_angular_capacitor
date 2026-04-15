import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ActivatedRouteSnapshot,
  Event as RouterEvent,
  Router,
} from '@angular/router';

import { EdgeRum } from '@edgemetrics/rum';
import { __resetEdgeRumForTests } from '../../core/src/EdgeRum';

import { RouterCapture } from '../src/RouterCapture';

const EVENT_TYPE = {
  NavigationStart: 0,
  NavigationEnd: 1,
  NavigationCancel: 2,
  NavigationError: 3,
} as const;

interface FakeSnapshotInput {
  readonly path?: string;
  readonly params?: Record<string, string>;
  readonly child?: FakeSnapshotInput;
}

function makeSnapshot(input: FakeSnapshotInput): ActivatedRouteSnapshot {
  const child = input.child ? makeSnapshot(input.child) : undefined;
  return {
    routeConfig: input.path !== undefined ? { path: input.path } : null,
    params: input.params ?? {},
    children: child ? [child] : [],
  } as unknown as ActivatedRouteSnapshot;
}

interface FakeRouterState {
  url: string;
  root: ActivatedRouteSnapshot;
}

function createFakeRouter(): {
  router: Router;
  events: Subject<RouterEvent>;
  state: FakeRouterState;
  setRoute: (url: string, root: ActivatedRouteSnapshot) => void;
  currentNavigation: { extras: { replaceUrl?: boolean } };
} {
  const events = new Subject<RouterEvent>();
  const state: FakeRouterState = {
    url: '/',
    root: makeSnapshot({}),
  };
  const currentNavigation = { extras: { replaceUrl: false as boolean | undefined } };
  const router = {
    events: events.asObservable(),
    routerState: { snapshot: state },
    getCurrentNavigation: () => currentNavigation,
  } as unknown as Router;
  return {
    router,
    events,
    state,
    currentNavigation,
    setRoute: (url, root) => {
      state.url = url;
      state.root = root;
    },
  };
}

function navStart(
  id: number,
  url: string,
  trigger: 'imperative' | 'popstate' | 'hashchange' = 'imperative'
): RouterEvent {
  return { type: EVENT_TYPE.NavigationStart, id, url, navigationTrigger: trigger } as unknown as RouterEvent;
}

function navEnd(id: number, url: string): RouterEvent {
  return { type: EVENT_TYPE.NavigationEnd, id, url, urlAfterRedirects: url } as unknown as RouterEvent;
}

function navCancel(id: number, url: string, reason = 'blocked'): RouterEvent {
  return { type: EVENT_TYPE.NavigationCancel, id, url, reason } as unknown as RouterEvent;
}

function navError(id: number, url: string, error: unknown): RouterEvent {
  return { type: EVENT_TYPE.NavigationError, id, url, error } as unknown as RouterEvent;
}

beforeEach(() => {
  __resetEdgeRumForTests();
  EdgeRum.init({ apiKey: 'edge_test_key' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RouterCapture', () => {
  it('normalises /products/9876 to /products/:id', () => {
    const trackSpy = vi.spyOn(EdgeRum, 'track');
    const harness = createFakeRouter();
    new RouterCapture(harness.router);

    harness.setRoute(
      '/products/9876',
      makeSnapshot({ path: 'products', child: { path: ':id', params: { id: '9876' } } })
    );
    harness.events.next(navStart(1, '/products/9876'));
    harness.events.next(navEnd(1, '/products/9876'));

    expect(trackSpy).toHaveBeenCalledTimes(1);
    const [name, attrs] = trackSpy.mock.calls[0]!;
    expect(name).toBe('screen_view');
    expect(attrs!['navigation.to_screen']).toBe('/products/:id');
    expect(String(attrs!['navigation.to_screen'])).not.toContain('9876');
  });

  it('emits a positive navigation.duration_ms', async () => {
    const trackSpy = vi.spyOn(EdgeRum, 'track');
    const harness = createFakeRouter();
    new RouterCapture(harness.router);

    harness.setRoute('/home', makeSnapshot({ path: 'home' }));
    harness.events.next(navStart(1, '/home'));
    await new Promise((r) => setTimeout(r, 5));
    harness.events.next(navEnd(1, '/home'));

    const [, attrs] = trackSpy.mock.calls[0]!;
    const duration = attrs!['navigation.duration_ms'];
    expect(typeof duration).toBe('number');
    expect(duration).toBeGreaterThan(0);
  });

  it('sets navigation.method to initial on the first navigation, push afterwards', () => {
    const trackSpy = vi.spyOn(EdgeRum, 'track');
    const harness = createFakeRouter();
    new RouterCapture(harness.router);

    harness.setRoute('/home', makeSnapshot({ path: 'home' }));
    harness.events.next(navStart(1, '/home'));
    harness.events.next(navEnd(1, '/home'));

    harness.setRoute('/about', makeSnapshot({ path: 'about' }));
    harness.events.next(navStart(2, '/about'));
    harness.events.next(navEnd(2, '/about'));

    expect(trackSpy.mock.calls[0]![1]!['navigation.method']).toBe('initial');
    expect(trackSpy.mock.calls[1]![1]!['navigation.method']).toBe('push');
  });

  it('sets navigation.method to pop when triggered by popstate', () => {
    const trackSpy = vi.spyOn(EdgeRum, 'track');
    const harness = createFakeRouter();
    new RouterCapture(harness.router);

    harness.setRoute('/home', makeSnapshot({ path: 'home' }));
    harness.events.next(navStart(1, '/home'));
    harness.events.next(navEnd(1, '/home'));

    harness.setRoute('/about', makeSnapshot({ path: 'about' }));
    harness.events.next(navStart(2, '/about', 'popstate'));
    harness.events.next(navEnd(2, '/about'));

    expect(trackSpy.mock.calls[1]![1]!['navigation.method']).toBe('pop');
  });

  it('sets navigation.method to replace when extras.replaceUrl is true', () => {
    const trackSpy = vi.spyOn(EdgeRum, 'track');
    const harness = createFakeRouter();
    new RouterCapture(harness.router);

    harness.setRoute('/home', makeSnapshot({ path: 'home' }));
    harness.events.next(navStart(1, '/home'));
    harness.events.next(navEnd(1, '/home'));

    harness.currentNavigation.extras.replaceUrl = true;
    harness.setRoute('/about', makeSnapshot({ path: 'about' }));
    harness.events.next(navStart(2, '/about'));
    harness.events.next(navEnd(2, '/about'));

    expect(trackSpy.mock.calls[1]![1]!['navigation.method']).toBe('replace');
  });

  it('sets navigation.method to cancel when navigation is cancelled', () => {
    const trackSpy = vi.spyOn(EdgeRum, 'track');
    const harness = createFakeRouter();
    new RouterCapture(harness.router);

    harness.setRoute('/home', makeSnapshot({ path: 'home' }));
    harness.events.next(navStart(1, '/home'));
    harness.events.next(navCancel(1, '/home', 'blocked by guard'));

    const [name, attrs] = trackSpy.mock.calls[0]!;
    expect(name).toBe('screen_view');
    expect(attrs!['navigation.method']).toBe('cancel');
  });

  it('omits navigation.from_screen on the first navigation and sets it on subsequent navigations', () => {
    const trackSpy = vi.spyOn(EdgeRum, 'track');
    const harness = createFakeRouter();
    new RouterCapture(harness.router);

    harness.setRoute('/home', makeSnapshot({ path: 'home' }));
    harness.events.next(navStart(1, '/home'));
    harness.events.next(navEnd(1, '/home'));

    harness.setRoute('/about', makeSnapshot({ path: 'about' }));
    harness.events.next(navStart(2, '/about'));
    harness.events.next(navEnd(2, '/about'));

    expect(trackSpy.mock.calls[0]![1]!['navigation.from_screen']).toBeUndefined();
    expect(trackSpy.mock.calls[1]![1]!['navigation.from_screen']).toBe('/home');
  });

  it('emits an app.crash event with exception_type NavigationError when navigation errors', () => {
    const trackSpy = vi.spyOn(EdgeRum, 'track');
    const harness = createFakeRouter();
    new RouterCapture(harness.router);

    harness.events.next(navStart(1, '/broken'));
    harness.events.next(navError(1, '/broken', new Error('route not found')));

    const [name, attrs] = trackSpy.mock.calls[0]!;
    expect(name).toBe('app.crash');
    expect(attrs!['exception_type']).toBe('NavigationError');
    expect(attrs!['message']).toBe('route not found');
    expect(attrs!['error_context']).toBe('navigation:/broken');
    expect(attrs!['is_fatal']).toBe(false);
    expect(attrs!['handled']).toBe(false);
  });

  it('handles a NavigationError whose error is a string', () => {
    const trackSpy = vi.spyOn(EdgeRum, 'track');
    const harness = createFakeRouter();
    new RouterCapture(harness.router);

    harness.events.next(navStart(1, '/boom'));
    harness.events.next(navError(1, '/boom', 'string-error'));

    const [name, attrs] = trackSpy.mock.calls[0]!;
    expect(name).toBe('app.crash');
    expect(attrs!['message']).toBe('string-error');
  });

  it('sets navigation.has_arguments to true when the route has params', () => {
    const trackSpy = vi.spyOn(EdgeRum, 'track');
    const harness = createFakeRouter();
    new RouterCapture(harness.router);

    harness.setRoute(
      '/products/42',
      makeSnapshot({ path: 'products', child: { path: ':id', params: { id: '42' } } })
    );
    harness.events.next(navStart(1, '/products/42'));
    harness.events.next(navEnd(1, '/products/42'));

    expect(trackSpy.mock.calls[0]![1]!['navigation.has_arguments']).toBe(true);
  });

  it('sets navigation.has_arguments to true when the url has a query string', () => {
    const trackSpy = vi.spyOn(EdgeRum, 'track');
    const harness = createFakeRouter();
    new RouterCapture(harness.router);

    harness.setRoute('/search?q=abc', makeSnapshot({ path: 'search' }));
    harness.events.next(navStart(1, '/search?q=abc'));
    harness.events.next(navEnd(1, '/search?q=abc'));

    expect(trackSpy.mock.calls[0]![1]!['navigation.has_arguments']).toBe(true);
  });

  it('emits only primitive attribute values — no nested objects', () => {
    const trackSpy = vi.spyOn(EdgeRum, 'track');
    const harness = createFakeRouter();
    new RouterCapture(harness.router);

    harness.setRoute('/home', makeSnapshot({ path: 'home' }));
    harness.events.next(navStart(1, '/home'));
    harness.events.next(navEnd(1, '/home'));

    const [, attrs] = trackSpy.mock.calls[0]!;
    for (const value of Object.values(attrs!)) {
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
  });

  it('never leaks OTel terminology in emitted payloads', () => {
    const trackSpy = vi.spyOn(EdgeRum, 'track');
    const harness = createFakeRouter();
    new RouterCapture(harness.router);

    harness.setRoute('/home', makeSnapshot({ path: 'home' }));
    harness.events.next(navStart(1, '/home'));
    harness.events.next(navEnd(1, '/home'));

    const serialised = JSON.stringify(trackSpy.mock.calls);
    expect(serialised).not.toContain('traceId');
    expect(serialised).not.toContain('spanId');
    expect(serialised).not.toContain('resourceSpans');
    expect(serialised).not.toContain('instrumentationScope');
    expect(serialised).not.toContain('opentelemetry');
  });

  it('unsubscribes on destroy so no further events are processed', () => {
    const trackSpy = vi.spyOn(EdgeRum, 'track');
    const harness = createFakeRouter();
    const capture = new RouterCapture(harness.router);

    capture.ngOnDestroy();

    harness.setRoute('/home', makeSnapshot({ path: 'home' }));
    harness.events.next(navStart(1, '/home'));
    harness.events.next(navEnd(1, '/home'));

    expect(trackSpy).not.toHaveBeenCalled();
  });
});

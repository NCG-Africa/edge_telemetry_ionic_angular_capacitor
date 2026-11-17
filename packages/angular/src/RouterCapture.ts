import { Injectable, type OnDestroy } from '@angular/core';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Router must be a value import for Angular DI injection
import { Router } from '@angular/router';
import type {
  ActivatedRouteSnapshot,
  Event as RouterEvent,
  NavigationError,
  NavigationStart,
} from '@angular/router';
import type { Subscription } from 'rxjs';
import { __getCurrentRoute, __navigationSpan, __recordEvent, __setCurrentRoute, __setLastNavigationMethod, type EventAttributes } from '@nathanclaire/rum';

/** Catalogue `navigation.method` values the router produces (processor #31). */
type NavigationMethod = 'push' | 'pop' | 'replace' | 'initial';

type RouteType = 'main_flow' | 'deeplink' | 'settings' | 'modal';

const EVENT_TYPE = {
  NavigationStart: 0,
  NavigationEnd: 1,
  NavigationCancel: 2,
  NavigationError: 3,
  ResolveStart: 5,
  ResolveEnd: 6,
  GuardsCheckStart: 7,
  GuardsCheckEnd: 8,
  RouteConfigLoadStart: 9,
  RouteConfigLoadEnd: 10,
} as const;

/** E19: router event type → phase key and open (+1) / close (-1). */
const PHASES: Readonly<Record<number, readonly [string, 1 | -1]>> = {
  [EVENT_TYPE.GuardsCheckStart]: ['navigation.guards_ms', 1],
  [EVENT_TYPE.GuardsCheckEnd]: ['navigation.guards_ms', -1],
  [EVENT_TYPE.ResolveStart]: ['navigation.resolvers_ms', 1],
  [EVENT_TYPE.ResolveEnd]: ['navigation.resolvers_ms', -1],
  [EVENT_TYPE.RouteConfigLoadStart]: ['navigation.chunk_load_ms', 1],
  [EVENT_TYPE.RouteConfigLoadEnd]: ['navigation.chunk_load_ms', -1],
};

/** Wall time a phase was open; nested lazy loads overlap, so it counts open-depth, not pairs. */
interface Phase { depth: number; openedAt: number; ms: number }

function normaliseRoute(root: ActivatedRouteSnapshot): string {
  const segments: string[] = [];
  let node: ActivatedRouteSnapshot | undefined = root;
  while (node) {
    const path = node.routeConfig?.path;
    if (path && path.length > 0) {
      segments.push(path);
    }
    node = node.children[0];
  }
  const joined = segments.join('/');
  return joined.length === 0 ? '/' : `/${joined}`;
}

function hasArguments(url: string, root: ActivatedRouteSnapshot): boolean {
  if (url.includes('?') || url.includes(';')) {
    return true;
  }
  let node: ActivatedRouteSnapshot | undefined = root;
  while (node) {
    if (Object.keys(node.params).length > 0) {
      return true;
    }
    node = node.children[0];
  }
  return false;
}

function classifyRoute(pattern: string): RouteType {
  if (pattern.startsWith('/settings')) {
    return 'settings';
  }
  if (pattern.includes('modal')) {
    return 'modal';
  }
  if (pattern.includes(':')) {
    return 'deeplink';
  }
  return 'main_flow';
}

interface PendingNav {
  readonly id: number;
  readonly trigger: NavigationStart['navigationTrigger'];
  readonly replaceUrl: boolean;
  /** X2 / X8: minted (or joined) at NavigationStart, stamped on the `navigation` event. */
  readonly span: EventAttributes;
  readonly phases: Record<string, Phase>;
}

@Injectable({ providedIn: 'root' })
export class RouterCapture implements OnDestroy {
  private readonly subscription: Subscription;
  private previousRoute: string | null = null;
  private isFirstNavigation = true;
  private pending: PendingNav | null = null;

  constructor(private readonly router: Router) {
    this.subscription = this.router.events.subscribe((event: RouterEvent) => {
      this.handleEvent(event);
    });
  }

  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }

  private handleEvent(event: RouterEvent): void {
    switch (event.type) {
      case EVENT_TYPE.NavigationStart: {
        const start = event as NavigationStart;
        this.pending = {
          id: start.id,
          trigger: start.navigationTrigger,
          replaceUrl: this.router.getCurrentNavigation()?.extras?.replaceUrl === true,
          span: __navigationSpan(),
          phases: {},
        };
        return;
      }
      case EVENT_TYPE.NavigationEnd: {
        this.emitRouteChange(this.methodForEnd());
        return;
      }
      case EVENT_TYPE.NavigationCancel: {
        // #149: a cancelled navigation changed no screen, so it is not a `navigation` (the
        // catalogue's method enum has no `cancel`); the next one is still `initial` if none landed.
        this.pending = null;
        return;
      }
      case EVENT_TYPE.NavigationError: {
        this.emitNavigationError(event as NavigationError);
        return;
      }
      default: {
        const phase = PHASES[event.type];
        // Outside a navigation (preloading) there is nothing to attribute the time to.
        if (phase && this.pending) this.trackPhase(this.pending, ...phase);
        return;
      }
    }
  }

  private trackPhase(nav: PendingNav, key: string, step: 1 | -1): void {
    const t = performance.now();
    const p = (nav.phases[key] ??= { depth: 0, openedAt: t, ms: 0 });
    if (step === 1) {
      if (p.depth++ === 0) p.openedAt = t;
    } else if (p.depth > 0 && --p.depth === 0) {
      p.ms += t - p.openedAt;
    }
  }

  private methodForEnd(): NavigationMethod {
    if (this.isFirstNavigation) {
      return 'initial';
    }
    if (this.pending?.trigger === 'popstate' || this.pending?.trigger === 'hashchange') {
      return 'pop';
    }
    if (this.pending?.replaceUrl) {
      return 'replace';
    }
    return 'push';
  }

  private emitRouteChange(method: NavigationMethod): void {
    const root = this.router.routerState.snapshot.root;
    const toRoute = normaliseRoute(root);
    const url = this.router.routerState.snapshot.url;

    const navAttrs: EventAttributes = {
      ...this.pending?.span,
      'navigation.to_screen': toRoute,
      'navigation.method': method,
      'navigation.route_type': classifyRoute(toRoute),
      'navigation.has_arguments': hasArguments(url, root),
    };
    for (const [key, p] of Object.entries(this.pending?.phases ?? {})) {
      // Still open (cancelled mid-phase): leave the key out — the backend column is nullable (G4).
      if (p.depth === 0) navAttrs[key] = Math.round(p.ms);
    }
    if (this.previousRoute !== null) {
      navAttrs['navigation.from_screen'] = this.previousRoute;
    }

    __recordEvent('navigation', navAttrs);
    __setCurrentRoute(toRoute);
    __setLastNavigationMethod(method);

    this.previousRoute = toRoute;
    this.isFirstNavigation = false;
    this.pending = null;
  }

  private emitNavigationError(event: NavigationError): void {
    const error: unknown = event.error;
    const message =
      error instanceof Error ? error.message : typeof error === 'string' ? error : 'Navigation failed';
    const stacktrace = error instanceof Error && error.stack ? error.stack : '';

    // #149: the router caught it and the app kept running, so it is `app.error`, on the `error.*`
    // keys. The failed URL is not sent (it may hold ids); `screen.name` is where the user still is.
    const attrs: EventAttributes = {
      'error.type': 'NavigationError',
      'error.message': message,
      'error.stacktrace': stacktrace,
      'error.cause': 'navigation_error',
      'error.source': 'webview',
      'screen.name': __getCurrentRoute(),
    };

    __recordEvent('app.error', attrs);
    this.pending = null;
  }
}

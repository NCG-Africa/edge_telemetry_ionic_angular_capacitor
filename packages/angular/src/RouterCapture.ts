import { Injectable, type OnDestroy } from '@angular/core';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Router must be a value import for Angular DI injection
import { Router } from '@angular/router';
import type {
  ActivatedRouteSnapshot,
  Event as RouterEvent,
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationStart,
} from '@angular/router';
import type { Subscription } from 'rxjs';
import { __recordEvent, type EventAttributes } from '@nathanclaire/rum';

type NavigationMethod = 'push' | 'pop' | 'replace' | 'initial' | 'cancel';

type RouteType = 'main_flow' | 'deeplink' | 'settings' | 'modal';

const EVENT_TYPE = {
  NavigationStart: 0,
  NavigationEnd: 1,
  NavigationCancel: 2,
  NavigationError: 3,
} as const;

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
  readonly startTime: number;
  readonly trigger: NavigationStart['navigationTrigger'];
  readonly replaceUrl: boolean;
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
          startTime: this.now(),
          trigger: start.navigationTrigger,
          replaceUrl: this.router.getCurrentNavigation()?.extras?.replaceUrl === true,
        };
        return;
      }
      case EVENT_TYPE.NavigationEnd: {
        const end = event as NavigationEnd;
        this.emitScreenView(this.methodForEnd(), end.id);
        return;
      }
      case EVENT_TYPE.NavigationCancel: {
        const cancel = event as NavigationCancel;
        this.emitScreenView('cancel', cancel.id);
        return;
      }
      case EVENT_TYPE.NavigationError: {
        this.emitNavigationError(event as NavigationError);
        return;
      }
      default:
        return;
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

  private emitScreenView(method: NavigationMethod, navId: number): void {
    const endTime = this.now();
    const root = this.router.routerState.snapshot.root;
    const toRoute = normaliseRoute(root);
    const startTime = this.pending?.id === navId ? this.pending.startTime : endTime;
    const durationMs = Math.max(0, endTime - startTime);
    const url = this.router.routerState.snapshot.url;

    const attrs: EventAttributes = {
      'navigation.to_screen': toRoute,
      'navigation.method': method,
      'navigation.route_type': classifyRoute(toRoute),
      'navigation.has_arguments': hasArguments(url, root),
      'navigation.timestamp': new Date().toISOString(),
      'navigation.duration_ms': durationMs,
    };
    if (this.previousRoute !== null) {
      attrs['navigation.from_screen'] = this.previousRoute;
    }

    __recordEvent('screen_view', attrs);

    this.previousRoute = toRoute;
    this.isFirstNavigation = false;
    this.pending = null;
  }

  private emitNavigationError(event: NavigationError): void {
    const error: unknown = event.error;
    const message =
      error instanceof Error ? error.message : typeof error === 'string' ? error : 'Navigation failed';
    const stacktrace = error instanceof Error && error.stack ? error.stack : '';

    const attrs: EventAttributes = {
      exception_type: 'NavigationError',
      message,
      stacktrace,
      is_fatal: false,
      handled: false,
      error_context: `navigation:${event.url}`,
      cause: 'NavigationError',
      runtime: 'webview',
    };

    __recordEvent('app.crash', attrs);
    this.pending = null;
  }

  private now(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }
}

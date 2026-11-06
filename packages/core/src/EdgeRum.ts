import {
  call, discard, event, flush, isName, isValue, live, metric, now, outside, route, routeListeners, setEnabled, start, state, whenReady,
  type AttributeValue, type EdgeRumOptions, type EventAttributes,
} from './core';
import { healthMonitor } from './internal/health';
import { crashAttributes, registerErrorCapture } from './instrumentation/errors';
import { registerRequestCapture } from './instrumentation/requests';
import { childSpan, clearRoot, navigationSpan, startTraces, traceRequest } from './traces';

/** Traits passed to `identify()`. */
export interface UserTraits {
  id?: string;
  name?: string;
  email?: string;
  phone?: string;
}

/** Handle returned by `time()`. */
export interface RumTimer {
  /** Stop the timer and record the elapsed milliseconds under the timer's name. */
  end(attributes?: EventAttributes): void;
}

const warn = (msg: string) => {
  if (state.options.debug) console.warn(`[edge-rum] ${msg}`);
};

// E29, copied from Cordova: a start costs nothing on the wire; one `task.complete` at the
// terminal. Restarting an open name restarts its clock.
const tasks = new Map<string, { start: number; attrs: EventAttributes }>();

type TaskOutcome = 'completed' | 'failed' | 'abandoned';

function endTask(name: string, outcome: TaskOutcome, extra: EventAttributes = {}) {
  const t = tasks.get(name);
  if (!t) return;
  tasks.delete(name);
  event('task.complete', {
    ...t.attrs,
    ...extra,
    'task.name': name,
    'task.outcome': outcome,
    'span.duration_ms': Math.round(performance.now() - t.start),
  });
}


let screen: { name: string; enteredAt: number } | null = null;
let lastNavigationMethod = 'navigate';

function leaveScreen(method: string) {
  if (!screen) return;
  event('screen.duration', {
    'screen.name': screen.name,
    'screen.duration_ms': Math.max(0, Date.now() - screen.enteredAt),
    'screen.exit_method': method,
    'screen.timestamp': now(),
  });
  screen = null;
}

function flat(attrs?: Record<string, unknown>): EventAttributes {
  const out: EventAttributes = {};
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (isValue(v)) out[k] = v;
  }
  return out;
}

/**
 * The Edge RUM API. Every method is fire-and-forget, safe to call before the native plugin
 * is ready, never throws, and is a silent no-op on web.
 */
export const EdgeRum = {
  /** Start capture. Call once, as early as possible; later calls are ignored. */
  init(opts: EdgeRumOptions = {}): void {
    if (!live()) {
      if (opts.debug) console.warn('[edge-rum] no native platform: nothing is captured on web');
      return;
    }
    if (state.started) return warn('init() already called; ignored');
    state.options = opts;
    // E29: open tasks end with the session native rotates.
    state.onSessionChange = () => {
      clearRoot(); // X9: a trace never spans sessions
      for (const name of [...tasks.keys()]) endTask(name, 'abandoned', { 'task.abandon_source': 'session_end' });
    };
    healthMonitor.setDebug(opts.debug === true);
    // C5: fail open; the key may come from capacitor.config.ts.
    if (typeof opts.apiKey === 'string' && !opts.apiKey.startsWith('edge_')) warn('apiKey should start with "edge_"');
    if (opts.apiKey || opts.endpoint) call('configure', { apiKey: opts.apiKey, endpoint: opts.endpoint });
    try {
      startTraces(opts.traceHostAllowlist);
    } catch (err) {
      healthMonitor.reportError('traces.start', err); // C5: init fails open
    }
    outside(() => {
      // L2: errors and requests are always on.
      registerErrorCapture({ recordEvent: event, flushPipeline: flush, getCurrentRoute: route });
      registerRequestCapture({
        recordEvent: event,
        ignoreUrls: [...(opts.endpoint ? [opts.endpoint] : []), ...(opts.ignoreUrls ?? [])],
        sanitizeUrl: opts.sanitizeUrl,
        trace: traceRequest,
        onSend: () => state.activity++,
      });
      for (const c of opts.captures ?? []) {
        try {
          const stop = c.start();
          if (stop) healthMonitor.registerCapture(c.name, stop);
        } catch (err) {
          healthMonitor.reportError(`${c.name}.register`, err);
        }
      }
    });
    start();
  },

  /** Attach a user to every event from now on (kept across launches until `clearUser()`). */
  identify(user: UserTraits): void {
    if (!user || typeof user !== 'object') return;
    const clean: UserTraits = {};
    for (const k of ['id', 'name', 'email', 'phone'] as const) if (typeof user[k] === 'string') clean[k] = user[k];
    call('identify', clean);
  },

  /** Forget the user set by `identify()`. */
  clearUser(): void {
    call('clearUser');
  },

  /** Record a named app event. */
  track(name: string, attributes?: EventAttributes): void {
    if (isName(name)) event('custom_event', { ...attributes, 'event.name': name });
  },

  /** Record an app-named number, e.g. `measure('cart.items', 3)`. */
  measure(name: string, value: number, attributes?: EventAttributes): void {
    if (isName(name) && typeof value === 'number' && isFinite(value)) metric(name, value, { ...attributes });
  },

  /** Start a timer; `end()` records the elapsed milliseconds via `measure()`. */
  time(name: string): RumTimer {
    const t0 = performance.now();
    let ended = false;
    return {
      end(attributes) {
        if (ended) return;
        ended = true;
        EdgeRum.measure(name, performance.now() - t0, attributes);
      },
    };
  },

  /** Report a screen change by name (for apps without the Angular router). */
  trackScreen(name: string, attributes?: EventAttributes): void {
    if (!isName(name)) return;
    leaveScreen('push');
    event('navigation', {
      'navigation.to_screen': name,
      'navigation.method': 'push',
      'navigation.has_arguments': false,
      'navigation.timestamp': now(),
      ...(state.route !== '/' && { 'navigation.from_screen': state.route }),
      ...attributes,
    });
    __setCurrentRoute(name);
    screen = { name, enteredAt: Date.now() };
  },

  /** Report an error the app caught. */
  captureError(error: unknown, attributes?: Record<string, unknown>): void {
    // E10. Host attrs first: they can't rewrite handled / cause / runtime.
    try {
      event('app.crash', { ...flat(attributes), ...crashAttributes(error, true, 'ManualCapture', state.route) });
    } catch (err) {
      healthMonitor.reportError('errors.capture', err); // a host error with throwing getters
    }
  },

  /** Start a named user journey (e.g. `checkout`); close it with `completeTask` or `failTask`. */
  startTask(name: string, attributes?: EventAttributes): void {
    if (live() && isName(name)) tasks.set(name, { start: performance.now(), attrs: { ...attributes } });
  },

  /** Close an open journey as completed. Unknown names are ignored. */
  completeTask(name: string): void {
    endTask(name, 'completed');
  },

  /** Close an open journey as failed, with an optional reason. Unknown names are ignored. */
  failTask(name: string, reason?: string): void {
    endTask(name, 'failed', typeof reason === 'string' ? { 'task.failure_reason': reason } : {});
  },

  /** Mark the app as ready for the user; launch time ends here if called within 30 s of startup. */
  markReady(): void {
    call('markPhase', { phase: 'markReady', ts: Date.now() });
  },

  /** Add an attribute to every JS event captured from now on. */
  setAttribute(key: string, value: AttributeValue): void {
    if (isName(key) && isValue(value)) state.globals[key] = value;
  },

  /** Stop adding an attribute set by `setAttribute()`. */
  removeAttribute(key: string): void {
    delete state.globals[key];
  },

  /** Turn capture on (remembered across launches). */
  enable(): void {
    if (!live()) return;
    setEnabled(true);
    call('enable');
  },

  /** Turn capture off (remembered across launches) and delete anything not yet sent. */
  disable(): void {
    if (!live()) return;
    setEnabled(false);
    call('disable');
  },

  /** Start over as a new device: new session, user cleared, unsent data deleted. */
  reset(): void {
    if (!live()) return;
    discard();
    call('reset');
  },

  /** The current session id once the native plugin is ready; empty string when there is none (e.g. on web). */
  getSessionId(): Promise<string> {
    if (!live()) return Promise.resolve('');
    return new Promise((resolve) => whenReady(() => resolve(state.sessionId ?? '')));
  },
};

// ── Internal hooks for @nathanclaire/rum-angular / -capacitor. Not public API. ──

export const __recordEvent = (eventName: string, attributes: EventAttributes): void => event(eventName, attributes);

export function __setCurrentRoute(route: string): void {
  if (route !== state.route) {
    state.activity++; // E25: a navigation answers a tap
    for (const f of routeListeners) f();
  }
  state.route = route;
  call('setLastScreen', { screen: route });
}

export const __getCurrentRoute = route;

/** X2 / X8: Router `NavigationStart` — Tier-1 keys for the `navigation` event. */
export function __navigationSpan(): EventAttributes {
  state.activity++; // E25: a navigation answers a tap now, not when it is reported
  try {
    return navigationSpan();
  } catch {
    return {}; // never break the app's navigation
  }
}

/** X6: Tier-1 child keys for a plugin call (`bridge()`), or nothing when no root is live. */
export function __childSpan(): EventAttributes | undefined {
  try {
    return childSpan();
  } catch {
    return undefined;
  }
}

/** Run `f` just before each screen change (while the old route is current); returns the unsubscribe. */
export function __onRouteChange(f: () => void): () => void {
  routeListeners.add(f);
  return () => void routeListeners.delete(f);
}

export function __setLastNavigationMethod(method: string): void {
  lastNavigationMethod = method;
}

export const __getLastNavigationMethod = (): string => lastNavigationMethod;

export function __beginScreen(name: string): void {
  if (isName(name)) screen = { name, enteredAt: Date.now() };
}

export function __flushActiveScreen(method = 'finalize'): void {
  leaveScreen(method);
}

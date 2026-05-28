import type { EdgeRumConfig, EventAttributes, UserContext } from './index';
import { SessionManager } from './session/SessionManager';
import { detectPlatformSync, getOrCreateAnonymousUserId } from './session/SessionIdGenerator';
import { healthMonitor } from './internal/health';
import { breadcrumbs } from './internal/breadcrumbs';
import { ContextManager } from './internal/context';
import { Collector } from './internal/collector';
import { Pipeline } from './internal/pipeline';
import { RetryTransport, type FetchLike } from './transport/RetryTransport';
import { OfflineQueue } from './queue/OfflineQueue';
import { registerConsoleErrorCapture, registerErrorCapture } from './instrumentation/errors';
import type { ConsoleErrorHandle, ErrorsHandle } from './instrumentation/errors';
import { registerVitalsCapture } from './instrumentation/vitals';
import { registerPageLoadCapture } from './instrumentation/pageload';
import { registerRequestCapture } from './instrumentation/requests';
import type { RequestsHandle } from './instrumentation/requests';
import { registerInteractionCapture } from './instrumentation/interactions';
import type { InteractionsHandle } from './instrumentation/interactions';
import { registerPerfObserver } from './instrumentation/perf-observer';
import type { PerfObserverHandle } from './instrumentation/perf-observer';

export interface RumTimer {
  end: (attributes?: EventAttributes) => void;
}

export interface EdgeRumRuntime {
  init: (config: EdgeRumConfig) => void;
  identify: (user: UserContext) => void;
  track: (name: string, attributes?: EventAttributes) => void;
  trackScreen: (name: string, attributes?: EventAttributes) => void;
  time: (name: string) => RumTimer;
  captureError: (error: Error, context?: Record<string, unknown>) => void;
  disable: () => void;
  enable: () => void;
  getSessionId: () => string;
}

const DEFAULT_BATCH_SIZE = 30;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_QUEUE_SIZE = 200;

interface InternalState {
  config: EdgeRumConfig | null;
  session: SessionManager | null;
  context: ContextManager | null;
  collector: Collector | null;
  pipeline: Pipeline | null;
  transport: RetryTransport | null;
  queue: OfflineQueue | null;
  errorsHandle: ErrorsHandle | null;
  consoleHandle: ConsoleErrorHandle | null;
  requestsHandle: RequestsHandle | null;
  interactionsHandle: InteractionsHandle | null;
  perfObserverHandle: PerfObserverHandle | null;
  enabled: boolean;
  initialized: boolean;
  currentRoute: string;
  lastNavigationMethod: string;
  activeScreen: { name: string; enteredAt: number } | null;
}

const state: InternalState = {
  config: null,
  session: null,
  context: null,
  collector: null,
  pipeline: null,
  transport: null,
  queue: null,
  errorsHandle: null,
  consoleHandle: null,
  requestsHandle: null,
  interactionsHandle: null,
  perfObserverHandle: null,
  enabled: true,
  initialized: false,
  currentRoute: '/',
  lastNavigationMethod: 'navigate',
  activeScreen: null,
};

function debug(event: string, payload: Record<string, unknown>): void {
  if (state.config?.debug) {
    // eslint-disable-next-line no-console
    console.warn(`[edge-rum] ${event}`, payload);
  }
}

function assertInitialized(method: string): void {
  if (!state.initialized) {
    throw new Error(`edge-rum: init() must be called before ${method}()`);
  }
}

function validateConfig(config: EdgeRumConfig): void {
  if (!config || typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
    throw new Error('edge-rum: apiKey is required');
  }
  if (!config.apiKey.startsWith('edge_')) {
    throw new Error('edge-rum: apiKey must start with "edge_"');
  }
  if (!config.endpoint || typeof config.endpoint !== 'string' || config.endpoint.length === 0) {
    throw new Error('edge-rum: endpoint is required');
  }
}

export const EdgeRum: EdgeRumRuntime = {
  init(config: EdgeRumConfig): void {
    validateConfig(config);
    state.config = config;
    healthMonitor.setDebug(config.debug === true);

    const session = new SessionManager({
      platform: detectPlatformSync(),
      sampleRate: config.sampleRate,
    });
    state.session = session;

    const context = new ContextManager(session);
    context.setAppAttributes(config);
    context.setAnonymousUserId(getOrCreateAnonymousUserId());
    state.context = context;

    const queue = new OfflineQueue({
      maxQueueSize: config.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      debug: config.debug,
    });
    state.queue = queue;

    const transport = new RetryTransport({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      debug: config.debug,
    });
    state.transport = transport;

    const pipeline = new Pipeline({
      transport,
      queue,
      session,
      context,
      batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
      flushIntervalMs: config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      location: config.location,
      deferReady: config.deferFlush,
      debug: config.debug,
    });
    state.pipeline = pipeline;

    const collector = new Collector({
      context,
      pipeline,
      session,
      debug: config.debug,
    });
    state.collector = collector;

    collector.recordEvent('session.started', { 'session.start_reason': 'init' });

    state.errorsHandle = registerErrorCapture({
      recordEvent: (eventName, attributes) => collector.recordEvent(eventName, attributes),
      flushPipeline: () => collector.flushPipeline(),
      getCurrentRoute: () => state.currentRoute,
    });

    if (config.captureConsoleErrors !== false) {
      try {
        state.consoleHandle = registerConsoleErrorCapture({
          recordEvent: (eventName, attributes) => collector.recordEvent(eventName, attributes),
          getCurrentRoute: () => state.currentRoute,
        });
      } catch (err) {
        healthMonitor.reportError('console.register', err);
      }
    }

    try {
      registerVitalsCapture({
        recordMetric: (metricName, value, attributes) =>
          collector.recordMetric(metricName, value, attributes),
        getCurrentRoute: () => state.currentRoute,
      });
    } catch {
      // web-vitals requires a browser environment; skip in Node/SSR.
    }

    registerPageLoadCapture({
      recordEvent: (eventName, attributes) => collector.recordEvent(eventName, attributes),
      getRoute: () => state.currentRoute,
    });

    // Always exclude the SDK's own telemetry endpoint so request capture
    // never records its own POSTs — prevents an infinite self-capture loop
    // and removes a quiet footgun for consumers.
    const effectiveIgnoreUrls = [config.endpoint, ...(config.ignoreUrls ?? [])];

    state.requestsHandle = registerRequestCapture({
      recordEvent: (eventName, attributes) => collector.recordEvent(eventName, attributes),
      ignoreUrls: effectiveIgnoreUrls,
      sanitizeUrl: config.sanitizeUrl,
    });

    try {
      state.interactionsHandle = registerInteractionCapture({
        recordEvent: (eventName, attributes) => collector.recordEvent(eventName, attributes),
        getCurrentRoute: () => state.currentRoute,
      });
    } catch (err) {
      healthMonitor.reportError('interactions.register', err);
    }

    try {
      state.perfObserverHandle = registerPerfObserver({
        recordMetric: (name, value, attrs) => collector.recordMetric(name, value, attrs),
        getCurrentRoute: () => state.currentRoute,
        ignoreResourceUrl: (url) => url === config.endpoint,
      });
    } catch (err) {
      healthMonitor.reportError('perf-observer.register', err);
    }

    pipeline.start();

    state.initialized = true;
    state.enabled = true;

    debug('initialized', { endpoint: config.endpoint });
  },

  identify(user: UserContext): void {
    assertInitialized('identify');
    if (!state.context || !state.collector) return;
    state.context.setUserAttributes(user);
    if (!state.enabled) {
      debug('identify', { name: user.name, email: user.email, phone: user.phone });
      return;
    }
    const version = state.context.incrementProfileVersion();
    const attrs: EventAttributes = {
      'user.profile_version': version,
      'user.profile_updated_at': new Date().toISOString(),
    };
    if (typeof user.name === 'string') attrs['user.name'] = user.name;
    if (typeof user.email === 'string') attrs['user.email'] = user.email;
    if (typeof user.phone === 'string') attrs['user.phone'] = user.phone;
    state.collector.recordEvent('user.profile.update', attrs);
    debug('identify', { name: user.name, email: user.email, phone: user.phone });
  },

  track(name: string, attributes?: EventAttributes): void {
    assertInitialized('track');
    if (!state.enabled || !state.collector) return;
    state.collector.recordEvent('custom_event', {
      'event.name': name,
      ...(attributes ?? {}),
    });
    debug('track', { name, attributes });
  },

  trackScreen(name: string, attributes?: EventAttributes): void {
    assertInitialized('trackScreen');
    if (!state.enabled || !state.collector || !state.session) return;
    if (typeof name !== 'string' || name.length === 0) return;
    const method = typeof attributes?.['navigation.method'] === 'string'
      ? (attributes['navigation.method'] as string)
      : 'push';
    // Close out the previous screen with a screen.duration before the navigation.
    flushActiveScreenInternal(method, state.collector);
    const prev = state.session.getLastVisitedScreen();
    const attrs: EventAttributes = {
      'navigation.to_screen': name,
      'navigation.method': 'push',
      'navigation.has_arguments': false,
      'navigation.timestamp': new Date().toISOString(),
      ...(prev !== null ? { 'navigation.from_screen': prev } : {}),
      ...(attributes ?? {}),
    };
    state.collector.recordEvent('navigation', attrs);
    state.currentRoute = name;
    state.lastNavigationMethod = method;
    state.activeScreen = { name, enteredAt: Date.now() };
    debug('trackScreen', { name, attributes });
  },

  time(name: string): RumTimer {
    assertInitialized('time');
    const startedAt = Date.now();
    return {
      end: (attributes?: EventAttributes): void => {
        if (!state.enabled || !state.collector) return;
        const durationMs = Date.now() - startedAt;
        state.collector.recordMetric(name, durationMs, {
          'metric.unit': 'ms',
          ...(attributes ?? {}),
        });
        debug('time.end', { name, durationMs, attributes });
      },
    };
  },

  captureError(error: Error, context?: Record<string, unknown>): void {
    assertInitialized('captureError');
    if (!state.enabled || !state.collector) return;

    const flatContext: EventAttributes = {};
    if (context) {
      for (const [key, value] of Object.entries(context)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          flatContext[key] = value;
        }
      }
    }

    const crumbs = breadcrumbs.snapshot();
    state.collector.recordEvent('app.crash', {
      exception_type: error.name || 'Error',
      message: error.message || '',
      stacktrace: error.stack || '',
      is_fatal: false,
      handled: true,
      error_context: `screen:${state.currentRoute}`,
      cause: 'ManualCapture',
      runtime: 'webview',
      'crash.breadcrumbs': JSON.stringify(crumbs),
      'crash.breadcrumb_count': crumbs.length,
      ...flatContext,
    });
    debug('captureError', { message: error.message, context });
  },

  disable(): void {
    state.enabled = false;
    state.collector?.setEnabled(false);
    state.pipeline?.stop();
    if (state.queue) {
      void state.queue.clear();
    }
  },

  enable(): void {
    state.enabled = true;
    state.collector?.setEnabled(true);
    state.pipeline?.start();
    if (state.pipeline) {
      void state.pipeline.flushOfflineQueue();
    }
  },

  getSessionId(): string {
    return state.session?.getSessionId() ?? '';
  },
};

export function __recordEvent(eventName: string, attributes: EventAttributes): void {
  if (!state.enabled || !state.collector) return;
  state.collector.recordEvent(eventName, attributes);
}

const currentRouteListeners: Array<(route: string) => void> = [];

export function __setCurrentRoute(route: string): void {
  state.currentRoute = route;
  for (const listener of currentRouteListeners) {
    try {
      listener(route);
    } catch (err) {
      // Listener errors must not break navigation — route via health monitor.
      healthMonitor.reportError('currentRoute.listener', err);
    }
  }
}

export function __getCurrentRoute(): string {
  return state.currentRoute;
}

export function __subscribeToCurrentRoute(cb: (route: string) => void): () => void {
  currentRouteListeners.push(cb);
  return () => {
    const idx = currentRouteListeners.indexOf(cb);
    if (idx >= 0) currentRouteListeners.splice(idx, 1);
  };
}

export function __setLastNavigationMethod(method: string): void {
  state.lastNavigationMethod = method;
}

export function __getLastNavigationMethod(): string {
  return state.lastNavigationMethod;
}

function flushActiveScreenInternal(method: string, collector: Collector | null): void {
  const screen = state.activeScreen;
  if (!screen || !collector) return;
  const durationMs = Math.max(0, Date.now() - screen.enteredAt);
  const timestamp = new Date().toISOString();
  collector.recordEvent('screen.duration', {
    'screen.name': screen.name,
    'screen.duration_ms': durationMs,
    'screen.exit_method': method,
    'screen.timestamp': timestamp,
  });
  state.activeScreen = null;
}

export function __beginScreen(name: string): void {
  if (!state.enabled) return;
  if (typeof name !== 'string' || name.length === 0) return;
  state.activeScreen = { name, enteredAt: Date.now() };
}

export function __flushActiveScreen(method = 'finalize'): void {
  if (!state.enabled) return;
  flushActiveScreenInternal(method, state.collector);
}

export function __getCollector(): Collector | null {
  return state.collector;
}

export function __getSession(): SessionManager | null {
  return state.session;
}

export function __getContext(): ContextManager | null {
  return state.context;
}

export function __getPipeline(): Pipeline | null {
  return state.pipeline;
}

export function __setTransportFetch(fetchFn: FetchLike): void {
  state.transport?.setFetchFn(fetchFn);
}

export function __resetEdgeRumForTests(): void {
  state.pipeline?.stop();
  state.errorsHandle?.dispose();
  state.consoleHandle?.dispose();
  state.requestsHandle?.dispose();
  state.interactionsHandle?.dispose();
  state.perfObserverHandle?.dispose();
  state.config = null;
  state.session = null;
  state.context = null;
  state.collector = null;
  state.pipeline = null;
  state.transport = null;
  state.queue = null;
  state.errorsHandle = null;
  state.consoleHandle = null;
  state.requestsHandle = null;
  state.interactionsHandle = null;
  state.perfObserverHandle = null;
  state.enabled = true;
  state.initialized = false;
  state.currentRoute = '/';
  state.lastNavigationMethod = 'navigate';
  state.activeScreen = null;
  healthMonitor.reset();
  breadcrumbs.reset();
  currentRouteListeners.length = 0;
}

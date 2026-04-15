import type { EdgeRumConfig, EventAttributes, UserContext } from './index';
import { SessionManager } from './session/SessionManager';
import { ContextManager } from './internal/context';
import { Collector } from './internal/collector';
import { Pipeline } from './internal/pipeline';
import { RetryTransport } from './transport/RetryTransport';
import { OfflineQueue } from './queue/OfflineQueue';
import { registerErrorCapture } from './instrumentation/errors';
import type { ErrorsHandle } from './instrumentation/errors';
import { registerVitalsCapture } from './instrumentation/vitals';
import { registerPageLoadCapture } from './instrumentation/pageload';

export interface RumTimer {
  end: (attributes?: EventAttributes) => void;
}

export interface EdgeRumRuntime {
  init: (config: EdgeRumConfig) => void;
  identify: (user: UserContext) => void;
  track: (name: string, attributes?: EventAttributes) => void;
  time: (name: string) => RumTimer;
  captureError: (error: Error, context?: Record<string, unknown>) => void;
  disable: () => void;
  enable: () => void;
  getSessionId: () => string;
}

const DEFAULT_ENDPOINT = 'https://edgetelemetry.ncgafrica.com/collector/telemetry';
const DEFAULT_BATCH_SIZE = 30;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_QUEUE_SIZE = 200;

interface InternalState {
  config: EdgeRumConfig | null;
  session: SessionManager | null;
  context: ContextManager | null;
  collector: Collector | null;
  pipeline: Pipeline | null;
  queue: OfflineQueue | null;
  errorsHandle: ErrorsHandle | null;
  enabled: boolean;
  initialized: boolean;
  currentRoute: string;
}

const state: InternalState = {
  config: null,
  session: null,
  context: null,
  collector: null,
  pipeline: null,
  queue: null,
  errorsHandle: null,
  enabled: true,
  initialized: false,
  currentRoute: '/',
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
}

export const EdgeRum: EdgeRumRuntime = {
  init(config: EdgeRumConfig): void {
    validateConfig(config);
    state.config = config;

    const session = new SessionManager();
    state.session = session;

    const context = new ContextManager(session);
    context.setAppAttributes(config);
    state.context = context;

    const queue = new OfflineQueue({
      maxQueueSize: config.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      debug: config.debug,
    });
    state.queue = queue;

    const transport = new RetryTransport({
      endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
      apiKey: config.apiKey,
      debug: config.debug,
    });

    const pipeline = new Pipeline({
      transport,
      queue,
      session,
      batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
      flushIntervalMs: config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      debug: config.debug,
    });
    state.pipeline = pipeline;

    const collector = new Collector({
      context,
      pipeline,
      sampleRate: config.sampleRate,
      debug: config.debug,
    });
    state.collector = collector;

    state.errorsHandle = registerErrorCapture({
      recordEvent: (eventName, attributes) => collector.recordEvent(eventName, attributes),
      flushPipeline: () => collector.flushPipeline(),
      getCurrentRoute: () => state.currentRoute,
    });

    try {
      registerVitalsCapture({
        recordEvent: (eventName, attributes) => collector.recordEvent(eventName, attributes),
        getCurrentRoute: () => state.currentRoute,
      });
    } catch {
      // web-vitals requires a browser environment; skip in Node/SSR.
    }

    registerPageLoadCapture({
      recordEvent: (eventName, attributes) => collector.recordEvent(eventName, attributes),
      getRoute: () => state.currentRoute,
    });

    pipeline.start();

    state.initialized = true;
    state.enabled = true;

    debug('initialized', { endpoint: config.endpoint ?? DEFAULT_ENDPOINT });
  },

  identify(user: UserContext): void {
    assertInitialized('identify');
    state.context?.setUserAttributes(user);
    debug('identify', { userId: user.id });
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

  time(name: string): RumTimer {
    assertInitialized('time');
    const startedAt = Date.now();
    return {
      end: (attributes?: EventAttributes): void => {
        if (!state.enabled || !state.collector) return;
        const durationMs = Date.now() - startedAt;
        state.collector.recordEvent('custom_metric', {
          'metric.name': name,
          'metric.value': durationMs,
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

    state.collector.recordEvent('app.crash', {
      exception_type: error.name || 'Error',
      message: error.message || '',
      stacktrace: error.stack || '',
      is_fatal: false,
      handled: true,
      error_context: `screen:${state.currentRoute}`,
      cause: 'ManualCapture',
      runtime: 'webview',
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

export function __setCurrentRoute(route: string): void {
  state.currentRoute = route;
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

export function __resetEdgeRumForTests(): void {
  state.pipeline?.stop();
  state.errorsHandle?.dispose();
  state.config = null;
  state.session = null;
  state.context = null;
  state.collector = null;
  state.pipeline = null;
  state.queue = null;
  state.errorsHandle = null;
  state.enabled = true;
  state.initialized = false;
  state.currentRoute = '/';
}

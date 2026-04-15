import type { EdgeRumConfig, EventAttributes, UserContext } from './index';

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

interface InternalState {
  config: EdgeRumConfig | null;
  user: UserContext | null;
  sessionId: string;
  enabled: boolean;
  initialized: boolean;
}

function generateId(prefix: 'session' | 'user'): string {
  const hex = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  const suffix = prefix === 'session' ? '_web' : '';
  return `${prefix}_${Date.now()}_${hex}${suffix}`;
}

const state: InternalState = {
  config: null,
  user: null,
  sessionId: generateId('session'),
  enabled: true,
  initialized: false,
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
    state.initialized = true;
    state.enabled = true;
  },

  identify(user: UserContext): void {
    assertInitialized('identify');
    state.user = user;
  },

  track(name: string, attributes?: EventAttributes): void {
    assertInitialized('track');
    debug('track', { name, attributes });
  },

  time(name: string): RumTimer {
    assertInitialized('time');
    const startedAt = Date.now();
    return {
      end: (attributes?: EventAttributes): void => {
        debug('time.end', { name, durationMs: Date.now() - startedAt, attributes });
      },
    };
  },

  captureError(error: Error, context?: Record<string, unknown>): void {
    assertInitialized('captureError');
    debug('captureError', { message: error.message, context });
  },

  disable(): void {
    state.enabled = false;
  },

  enable(): void {
    state.enabled = true;
  },

  getSessionId(): string {
    return state.sessionId;
  },
};

export function __resetEdgeRumForTests(): void {
  state.config = null;
  state.user = null;
  state.sessionId = generateId('session');
  state.enabled = true;
  state.initialized = false;
}

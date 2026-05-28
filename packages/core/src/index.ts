export const SDK_VERSION = '3.3.2';
export const SDK_CONTRACT_VERSION = '3.1.0' as const;
export const SDK_PLATFORM = 'ionic-angular-capacitor' as const;

export interface EdgeRumConfig {
  apiKey: string;
  endpoint: string;
  appName?: string;
  appVersion?: string;
  appPackage?: string;
  appBuild?: string;
  environment?: 'production' | 'staging' | 'development';
  location?: string;
  sampleRate?: number;
  ignoreUrls?: (string | RegExp)[];
  maxQueueSize?: number;
  flushIntervalMs?: number;
  batchSize?: number;
  sanitizeUrl?: (url: string) => string;
  deferFlush?: boolean;
  debug?: boolean;
  captureConsoleErrors?: boolean;
  captureNativeCrashes?: boolean;
  enableAnrDetection?: boolean;
  enableHangDetection?: boolean;
  anrTimeoutMs?: number;
  hangTimeoutMs?: number;
  // Default false. When false (default), the native crash bridge's
  // `plugin.install()` and `plugin.fetchPending()` run on the next idle tick
  // instead of blocking the bootstrap critical path — typically a 50–150 ms
  // cold-start improvement on iOS. Opt in to `true` if you absolutely need
  // the native handlers armed before any other code runs (rare).
  awaitNativeInstall?: boolean;
}

export interface UserContext {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

export type EventAttributes = Record<string, string | number | boolean>;

export { EdgeRum, type EdgeRumRuntime, type RumTimer } from './EdgeRum';
export {
  __recordEvent,
  __setCurrentRoute,
  __getCurrentRoute,
  __subscribeToCurrentRoute,
  __setLastNavigationMethod,
  __getLastNavigationMethod,
  __beginScreen,
  __flushActiveScreen,
  __getCollector,
  __getSession,
  __getContext,
  __getPipeline,
  __setTransportFetch,
} from './EdgeRum';
export { healthMonitor } from './internal/health';
export type { FetchLike } from './transport/RetryTransport';

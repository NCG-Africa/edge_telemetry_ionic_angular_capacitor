export const SDK_VERSION = '3.0.0';
export const SDK_PLATFORM = 'ionic-angular-capacitor' as const;

export interface EdgeRumConfig {
  apiKey: string;
  endpoint: string;
  appName?: string;
  appVersion?: string;
  appPackage?: string;
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
  __getCollector,
  __getSession,
  __getContext,
  __getPipeline,
  __setTransportFetch,
} from './EdgeRum';
export type { FetchLike } from './transport/RetryTransport';

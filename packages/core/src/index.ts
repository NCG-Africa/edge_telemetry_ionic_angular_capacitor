export const SDK_VERSION = '1.0.0';
export const SDK_PLATFORM = 'ionic-angular-capacitor' as const;

export interface EdgeRumConfig {
  apiKey: string;
  endpoint?: string;
  appName?: string;
  appVersion?: string;
  appPackage?: string;
  environment?: 'production' | 'staging' | 'development';
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
  id?: string;
  [key: string]: string | number | boolean | undefined;
}

export type EventAttributes = Record<string, string | number | boolean>;

export { EdgeRum, type EdgeRumRuntime, type RumTimer } from './EdgeRum';
export { __recordEvent, __setCurrentRoute, __getCollector, __getSession, __getContext, __getPipeline } from './EdgeRum';

export const SDK_VERSION = '0.0.1';
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
  debug?: boolean;
}

export interface UserContext {
  id?: string;
  email?: string;
  [key: string]: string | number | boolean | undefined;
}

export type EventAttributes = Record<string, string | number | boolean>;

export { EdgeRum, type EdgeRumRuntime, type RumTimer } from './EdgeRum';

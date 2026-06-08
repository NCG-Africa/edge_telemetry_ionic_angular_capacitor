export const SDK_VERSION = '3.5.0';
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
  // Opt-in IP-based location resolution. When true and `location` is not
  // explicitly set, the SDK calls `locationProviderUrl` once on init and
  // stamps the resulting "City/Country" string into the batch envelope.
  // Off by default — enabling it sends the device IP to a third-party
  // provider, so consumers should confirm this is acceptable for their
  // privacy/compliance posture.
  resolveLocation?: boolean;
  // Override the IP-geolocation provider. Defaults to https://ipapi.co/json/.
  // Response must include `city` and either `country_name` (ipapi.co) or
  // `country` (ipinfo.io and most others).
  locationProviderUrl?: string;
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
  // Frame-render metrics — emitted as `metric` items with metricName
  // `frame_render_time`. Default on; slow-only by default to keep volume sane
  // (a fully idle screen emits zero events). Set `captureAllFrames` only when
  // debugging — emits one event per WebView frame regardless of duration.
  captureFrames?: boolean;
  captureAllFrames?: boolean;
  frameSlowThresholdMs?: number;
  // Memory samples — emitted as `metric` items with metricName `memory_usage`,
  // value in megabytes. Periodic plus on memory-pressure callbacks and
  // foreground/background transitions.
  captureMemory?: boolean;
  memorySamplingIntervalMs?: number;
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

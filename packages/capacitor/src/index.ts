export { SDK_PLATFORM, SDK_VERSION } from '@nathanclaire/rum';
export type { EdgeRumConfig, EventAttributes, UserContext } from '@nathanclaire/rum';

export { getDeviceContext } from './DeviceContext';
export type {
  DeviceContextAttributes,
  DeviceContextDeps,
  DevicePlatform,
} from './DeviceContext';

export { getInitialNetworkContext, startNetworkCapture } from './NetworkCapture';
export type {
  NetworkAttributes,
  NetworkCaptureCallbacks,
  NetworkCaptureDeps,
  NetworkCaptureHandle,
  NetworkConnectionType,
  NetworkModuleLike,
  NetworkStatusLike,
} from './NetworkCapture';

export { startCapacitorCapture, type CapacitorCaptureHandle } from './bootstrap';
export {
  startPerfSamplerCapture,
  type PerfSamplerCaptureDeps,
  type PerfSamplerCaptureHandle,
  type PerfSamplerCaptureOptions,
} from './PerfSamplerCapture';
export { createCapacitorHttpFetch } from './capacitor-http-fetch';
export type {
  CapacitorHttpFetchDeps,
  CapacitorHttpLike,
  CapacitorHttpRequestOptions,
  CapacitorHttpResponseLike,
} from './capacitor-http-fetch';
export type { FetchLike } from '@nathanclaire/rum';
export { startLifecycleCapture } from './LifecycleCapture';
export type {
  AppModuleLike,
  AppStateLike,
  LifecycleAttributes,
  LifecycleCaptureCallbacks,
  LifecycleCaptureDeps,
  LifecycleCaptureHandle,
  LifecycleEvent,
  LifecycleSessionManagerLike,
} from './LifecycleCapture';

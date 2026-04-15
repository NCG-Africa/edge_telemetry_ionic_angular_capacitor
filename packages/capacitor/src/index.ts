export { SDK_PLATFORM, SDK_VERSION } from '@edgemetrics/rum';
export type { EdgeRumConfig, EventAttributes, UserContext } from '@edgemetrics/rum';

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

export { SDK_PLATFORM, SDK_VERSION } from '@edgemetrics/rum';
export type { EdgeRumConfig, EventAttributes, UserContext } from '@edgemetrics/rum';

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

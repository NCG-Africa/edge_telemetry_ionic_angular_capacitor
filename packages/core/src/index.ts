export const SDK_VERSION = '5.0.0';

export { EdgeRum, type RumTimer, type UserTraits } from './EdgeRum';
export type { AttributeValue, Capture, EdgeRumEvent, EdgeRumOptions, EventAttributes } from './core';
export type { BeforeSend } from './beforeSend';
export { consoleErrors, defaultCaptures, frames, interactions, longTasks, resourceTiming, vitals } from './captures';

// Internal hooks for @nathanclaire/rum-angular / -capacitor. Not public API.
export {
  __recordEvent,
  __setCurrentRoute,
  __getCurrentRoute,
  __navigationSpan,
  __childSpan,
  __touchRoot,
  __onRouteChange,
  __setLastNavigationMethod,
  __getLastNavigationMethod,
  __beginScreen,
  __flushActiveScreen,
} from './EdgeRum';

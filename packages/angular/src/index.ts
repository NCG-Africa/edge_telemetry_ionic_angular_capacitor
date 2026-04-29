export { SDK_PLATFORM, SDK_VERSION } from '@nathanclaire/rum';
export type { EdgeRumConfig, EventAttributes, UserContext, RumTimer } from '@nathanclaire/rum';

export { EdgeRumService } from './EdgeRumService';
export {
  EdgeRumModule,
  provideEdgeRum,
  EDGE_RUM_CONFIG,
  edgeRumInitializerFactory,
} from './EdgeRumModule';
export { RouterCapture } from './RouterCapture';
export { EdgeRumErrorCapture } from './ErrorCapture';
export { IonicLifecycleCapture } from './IonicLifecycleCapture';

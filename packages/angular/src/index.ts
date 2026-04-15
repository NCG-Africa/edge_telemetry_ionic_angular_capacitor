export { SDK_PLATFORM, SDK_VERSION } from '@edgemetrics/rum';
export type { EdgeRumConfig, EventAttributes, UserContext, RumTimer } from '@edgemetrics/rum';

export { EdgeRumService } from './EdgeRumService';
export {
  EdgeRumModule,
  provideEdgeRum,
  EDGE_RUM_CONFIG,
  edgeRumInitializerFactory,
} from './EdgeRumModule';

import {
  APP_INITIALIZER,
  ErrorHandler,
  InjectionToken,
  NgModule,
  Optional,
  type ModuleWithProviders,
  type Provider,
} from '@angular/core';
import { EdgeRum, type EdgeRumConfig } from '@nathanclaire/rum';

import { EdgeRumErrorCapture } from './ErrorCapture';
import { EdgeRumService } from './EdgeRumService';
import { RouterCapture } from './RouterCapture';
import { IonicLifecycleCapture } from './IonicLifecycleCapture';

export const EDGE_RUM_CONFIG = new InjectionToken<EdgeRumConfig>('EDGE_RUM_CONFIG');

export function edgeRumInitializerFactory(
  config: EdgeRumConfig,
  _router: RouterCapture,
  _lifecycle: IonicLifecycleCapture | null,
): () => void {
  return () => {
    EdgeRum.init(config);
  };
}

function buildProviders(config: EdgeRumConfig): Provider[] {
  return [
    { provide: EDGE_RUM_CONFIG, useValue: config },
    EdgeRumService,
    RouterCapture,
    IonicLifecycleCapture,
    {
      provide: APP_INITIALIZER,
      useFactory: edgeRumInitializerFactory,
      deps: [EDGE_RUM_CONFIG, RouterCapture, [new Optional(), IonicLifecycleCapture]],
      multi: true,
    },
    { provide: ErrorHandler, useClass: EdgeRumErrorCapture },
  ];
}

@NgModule({})
export class EdgeRumModule {
  static forRoot(config: EdgeRumConfig): ModuleWithProviders<EdgeRumModule> {
    return {
      ngModule: EdgeRumModule,
      providers: buildProviders(config),
    };
  }
}

export function provideEdgeRum(config: EdgeRumConfig): Provider[] {
  return buildProviders(config);
}

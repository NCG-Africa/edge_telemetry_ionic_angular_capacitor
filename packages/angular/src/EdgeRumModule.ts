import {
  APP_INITIALIZER,
  InjectionToken,
  NgModule,
  type ModuleWithProviders,
  type Provider,
} from '@angular/core';
import { EdgeRum, type EdgeRumConfig } from '@edgemetrics/rum';

import { EdgeRumService } from './EdgeRumService';

export const EDGE_RUM_CONFIG = new InjectionToken<EdgeRumConfig>('EDGE_RUM_CONFIG');

export function edgeRumInitializerFactory(config: EdgeRumConfig): () => void {
  return () => {
    EdgeRum.init(config);
  };
}

function buildProviders(config: EdgeRumConfig): Provider[] {
  return [
    { provide: EDGE_RUM_CONFIG, useValue: config },
    EdgeRumService,
    {
      provide: APP_INITIALIZER,
      useFactory: edgeRumInitializerFactory,
      deps: [EDGE_RUM_CONFIG],
      multi: true,
    },
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

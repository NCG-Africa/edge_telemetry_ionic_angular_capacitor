import {
  APP_INITIALIZER,
  ErrorHandler,
  InjectionToken,
  NgModule,
  NgZone,
  Optional,
  makeEnvironmentProviders,
  type EnvironmentProviders,
  type ModuleWithProviders,
} from '@angular/core';
import { EdgeRum, type EdgeRumOptions } from '@nathanclaire/rum';
import { defaultCaptures } from '@nathanclaire/rum-capacitor';

import { chainErrorHandler } from './ErrorCapture';
import { EdgeRumService } from './EdgeRumService';
import { RouterCapture } from './RouterCapture';
import { IonicLifecycleCapture } from './IonicLifecycleCapture';

export const EDGE_RUM_CONFIG = new InjectionToken<EdgeRumOptions>('EDGE_RUM_CONFIG');

export function edgeRumInitializerFactory(
  config: EdgeRumOptions,
  zone: NgZone,
  // Injected to force instantiation — constructors subscribe to Router/Ionic events
  _router: RouterCapture, // eslint-disable-line @typescript-eslint/no-unused-vars
  _lifecycle: IonicLifecycleCapture | null, // eslint-disable-line @typescript-eslint/no-unused-vars
  errorHandler: ErrorHandler | null = null,
): () => void {
  return () => {
    if (errorHandler) chainErrorHandler(errorHandler);
    // A8: SDK listeners and timers never trigger change detection.
    zone.runOutsideAngular(() => EdgeRum.init({ captures: defaultCaptures(), ...config }));
  };
}

/** C7: primary setup. `EdgeRumModule.forRoot` wraps it. */
export function provideEdgeRum(config: EdgeRumOptions = {}): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: EDGE_RUM_CONFIG, useValue: config },
    EdgeRumService,
    RouterCapture,
    IonicLifecycleCapture,
    {
      provide: APP_INITIALIZER,
      useFactory: edgeRumInitializerFactory,
      deps: [
        EDGE_RUM_CONFIG,
        NgZone,
        RouterCapture,
        [new Optional(), IonicLifecycleCapture],
        [new Optional(), ErrorHandler],
      ],
      multi: true,
    },
  ]);
}

@NgModule({})
export class EdgeRumModule {
  static forRoot(config: EdgeRumOptions = {}): ModuleWithProviders<EdgeRumModule> {
    return {
      ngModule: EdgeRumModule,
      providers: [provideEdgeRum(config)],
    };
  }
}


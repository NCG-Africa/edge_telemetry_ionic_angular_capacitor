import { Injectable } from '@angular/core';
import {
  EdgeRum,
  type EventAttributes,
  type RumTimer,
  type UserContext,
} from '@edgemetrics/rum';

@Injectable({ providedIn: 'root' })
export class EdgeRumService {
  identify(user: UserContext): void {
    EdgeRum.identify(user);
  }

  track(name: string, attributes?: EventAttributes): void {
    EdgeRum.track(name, attributes);
  }

  time(name: string): RumTimer {
    return EdgeRum.time(name);
  }

  captureError(error: Error, context?: Record<string, unknown>): void {
    EdgeRum.captureError(error, context);
  }

  disable(): void {
    EdgeRum.disable();
  }

  enable(): void {
    EdgeRum.enable();
  }

  getSessionId(): string {
    return EdgeRum.getSessionId();
  }
}

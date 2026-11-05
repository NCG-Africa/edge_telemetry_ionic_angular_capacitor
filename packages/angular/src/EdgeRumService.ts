import { Injectable } from '@angular/core';
import {
  EdgeRum,
  type AttributeValue,
  type EdgeRumOptions,
  type EventAttributes,
  type RumTimer,
  type UserTraits,
} from '@nathanclaire/rum';

/** Injectable mirror of `EdgeRum`; every method delegates. */
@Injectable({ providedIn: 'root' })
export class EdgeRumService {
  init(opts?: EdgeRumOptions): void { EdgeRum.init(opts); }
  identify(user: UserTraits): void { EdgeRum.identify(user); }
  clearUser(): void { EdgeRum.clearUser(); }
  track(name: string, attributes?: EventAttributes): void { EdgeRum.track(name, attributes); }
  measure(name: string, value: number, attributes?: EventAttributes): void { EdgeRum.measure(name, value, attributes); }
  time(name: string): RumTimer { return EdgeRum.time(name); }
  trackScreen(name: string, attributes?: EventAttributes): void { EdgeRum.trackScreen(name, attributes); }
  captureError(error: unknown, attributes?: Record<string, unknown>): void { EdgeRum.captureError(error, attributes); }
  startTask(name: string, attributes?: EventAttributes): void { EdgeRum.startTask(name, attributes); }
  completeTask(name: string): void { EdgeRum.completeTask(name); }
  failTask(name: string, reason?: string): void { EdgeRum.failTask(name, reason); }
  markReady(): void { EdgeRum.markReady(); }
  setAttribute(key: string, value: AttributeValue): void { EdgeRum.setAttribute(key, value); }
  removeAttribute(key: string): void { EdgeRum.removeAttribute(key); }
  enable(): void { EdgeRum.enable(); }
  disable(): void { EdgeRum.disable(); }
  reset(): void { EdgeRum.reset(); }
  getSessionId(): Promise<string> { return EdgeRum.getSessionId(); }
}

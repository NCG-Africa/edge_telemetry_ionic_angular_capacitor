import { Inject, Injectable, InjectionToken, Optional, type OnDestroy } from '@angular/core';
import {
  __beginScreen,
  __flushActiveScreen,
  __getCurrentRoute,
  __getLastNavigationMethod,
} from '@nathanclaire/rum';

export const LIFECYCLE_EVENT_SOURCE = new InjectionToken<EventTarget>('LIFECYCLE_EVENT_SOURCE');

const DID_ENTER = 'ionViewDidEnter';
const DID_LEAVE = 'ionViewDidLeave';
// Object form, not `true`: Node ≤20's EventTarget ignores a boolean capture flag on removeEventListener.
const CAPTURE = { capture: true };

function resolveScreenName(target: EventTarget | null): string {
  // Prefer the canonical route from the SDK state — keeps screen.* keys in
  // sync with the navigation.to_screen used by visited_screens / dashboards.
  const route = __getCurrentRoute();
  if (route && route !== '/') return route;
  // Fall back to the Ionic component tag for the pre-first-navigation case.
  if (target && typeof (target as Element).tagName === 'string') {
    const tag = (target as Element).tagName;
    if (tag) return tag.toLowerCase();
  }
  return 'unknown';
}

@Injectable({ providedIn: 'root' })
export class IonicLifecycleCapture implements OnDestroy {
  private readonly source: EventTarget | null;
  private readonly didEnter = (e: Event): void => this.onDidEnter(e);
  private readonly didLeave = (): void => this.onDidLeave();

  constructor(
    @Optional() @Inject(LIFECYCLE_EVENT_SOURCE) source?: EventTarget | null,
  ) {
    this.source = source ?? (typeof document !== 'undefined' ? document : null);
    if (this.source) {
      // Capture phase: Ionic dispatches lifecycle events with bubbles: false on
      // the page element, so a bubble-phase document listener never sees them.
      this.source.addEventListener(DID_ENTER, this.didEnter, CAPTURE);
      this.source.addEventListener(DID_LEAVE, this.didLeave, CAPTURE);
    }
  }

  ngOnDestroy(): void {
    if (!this.source) {
      return;
    }
    this.source.removeEventListener(DID_ENTER, this.didEnter, CAPTURE);
    this.source.removeEventListener(DID_LEAVE, this.didLeave, CAPTURE);
  }

  private onDidEnter(event: Event): void {
    __beginScreen(resolveScreenName(event.target));
  }

  private onDidLeave(): void {
    __flushActiveScreen(__getLastNavigationMethod());
  }
}

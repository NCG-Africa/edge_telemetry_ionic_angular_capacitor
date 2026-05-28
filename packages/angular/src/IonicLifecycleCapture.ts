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
      this.source.addEventListener(DID_ENTER, this.didEnter);
      this.source.addEventListener(DID_LEAVE, this.didLeave);
    }
  }

  ngOnDestroy(): void {
    if (!this.source) {
      return;
    }
    this.source.removeEventListener(DID_ENTER, this.didEnter);
    this.source.removeEventListener(DID_LEAVE, this.didLeave);
  }

  private onDidEnter(event: Event): void {
    __beginScreen(resolveScreenName(event.target));
  }

  private onDidLeave(): void {
    __flushActiveScreen(__getLastNavigationMethod());
  }
}

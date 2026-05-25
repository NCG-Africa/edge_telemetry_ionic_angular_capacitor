import { Inject, Injectable, InjectionToken, Optional, type OnDestroy } from '@angular/core';
import {
  __getCurrentRoute,
  __getLastNavigationMethod,
  __recordEvent,
  type EventAttributes,
} from '@nathanclaire/rum';

export const LIFECYCLE_EVENT_SOURCE = new InjectionToken<EventTarget>('LIFECYCLE_EVENT_SOURCE');

interface CurrentScreen {
  readonly name: string;
  readonly enteredAt: number;
}

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
  private readonly didLeave = (e: Event): void => this.onDidLeave(e);

  private currentScreen: CurrentScreen | null = null;

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
    this.currentScreen = {
      name: resolveScreenName(event.target),
      enteredAt: Date.now(),
    };
  }

  private onDidLeave(event: Event): void {
    const name = this.currentScreen?.name ?? resolveScreenName(event.target);
    const enteredAt = this.currentScreen?.enteredAt ?? Date.now();
    const durationMs = Math.max(0, Date.now() - enteredAt);
    const timestamp = new Date().toISOString();

    const attrs: EventAttributes = {
      'screen.name': name,
      'screen.duration_ms': durationMs,
      'screen.exit_method': __getLastNavigationMethod(),
      'screen.timestamp': timestamp,
    };

    __recordEvent('screen.duration', attrs);
    this.currentScreen = null;
  }
}

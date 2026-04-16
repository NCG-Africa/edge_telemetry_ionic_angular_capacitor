import { Injectable } from '@angular/core';
import type { OnDestroy } from '@angular/core';
import { __recordEvent, type EventAttributes } from '@edgemetrics/rum';

type Phase = 'enter' | 'leave';

interface PendingTiming {
  readonly name: string;
  readonly t: number;
}

const WILL_ENTER = 'ionViewWillEnter';
const DID_ENTER = 'ionViewDidEnter';
const WILL_LEAVE = 'ionViewWillLeave';
const DID_LEAVE = 'ionViewDidLeave';

function resolveScreenName(target: EventTarget | null): string {
  if (target && typeof (target as Element).tagName === 'string') {
    return (target as Element).tagName.toLowerCase();
  }
  return 'unknown';
}

@Injectable({ providedIn: 'root' })
export class IonicLifecycleCapture implements OnDestroy {
  private readonly source: EventTarget | null;
  private readonly willEnter = (e: Event): void => this.onWill('enter', e);
  private readonly didEnter = (e: Event): void => this.onDid('enter', e);
  private readonly willLeave = (e: Event): void => this.onWill('leave', e);
  private readonly didLeave = (e: Event): void => this.onDid('leave', e);

  private pendingEnter: PendingTiming | null = null;
  private pendingLeave: PendingTiming | null = null;

  constructor(source?: EventTarget) {
    this.source = source ?? (typeof document !== 'undefined' ? document : null);
    if (this.source) {
      this.source.addEventListener(WILL_ENTER, this.willEnter);
      this.source.addEventListener(DID_ENTER, this.didEnter);
      this.source.addEventListener(WILL_LEAVE, this.willLeave);
      this.source.addEventListener(DID_LEAVE, this.didLeave);
    }
  }

  ngOnDestroy(): void {
    if (!this.source) {
      return;
    }
    this.source.removeEventListener(WILL_ENTER, this.willEnter);
    this.source.removeEventListener(DID_ENTER, this.didEnter);
    this.source.removeEventListener(WILL_LEAVE, this.willLeave);
    this.source.removeEventListener(DID_LEAVE, this.didLeave);
  }

  private onWill(phase: Phase, event: Event): void {
    const timing: PendingTiming = { name: resolveScreenName(event.target), t: Date.now() };
    if (phase === 'enter') {
      this.pendingEnter = timing;
    } else {
      this.pendingLeave = timing;
    }
  }

  private onDid(phase: Phase, event: Event): void {
    const endTime = Date.now();
    const pending = phase === 'enter' ? this.pendingEnter : this.pendingLeave;
    const name = pending?.name ?? resolveScreenName(event.target);
    const durationMs = pending ? Math.max(0, endTime - pending.t) : 0;

    const attrs: EventAttributes = {
      'screen.name': name,
      'screen.event': phase,
      'screen.duration_ms': durationMs,
    };

    __recordEvent('screen_timing', attrs);

    if (phase === 'enter') {
      this.pendingEnter = null;
    } else {
      this.pendingLeave = null;
    }
  }
}

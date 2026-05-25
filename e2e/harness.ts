import {
  EdgeRum,
  __getCollector,
  __getSession,
  __recordEvent,
} from '../packages/core/dist/index.mjs';
import type { EdgeRumConfig } from '../packages/core/dist/index.d.ts';

declare global {
  interface Window {
    __edgeRumHarness: {
      init: (config: EdgeRumConfig) => void;
      identify: Parameters<typeof EdgeRum.identify>[0] extends infer U
        ? (user: U) => void
        : never;
      track: (name: string, attrs?: Record<string, string | number | boolean>) => void;
      trackScreen: (name: string, attrs?: Record<string, string | number | boolean>) => void;
      captureError: (message: string, context?: Record<string, unknown>) => void;
      time: (name: string, durationMs: number) => void;
      getSessionId: () => string;
      disable: () => void;
      enable: () => void;
      dispatchPagehide: () => void;
    };
  }
}

// Tracks pagehide-driven finalizations so we don't double-emit on the synthetic
// pagehide path. Mirrors LifecycleCapture's `appCloseFinalized` flag.
let appCloseFinalized = false;

window.__edgeRumHarness = {
  init: (config) => {
    EdgeRum.init(config);
    appCloseFinalized = false;
  },
  identify: (user) => EdgeRum.identify(user),
  track: (name, attrs) => EdgeRum.track(name, attrs),
  trackScreen: (name, attrs) => EdgeRum.trackScreen(name, attrs),
  captureError: (message, context) => {
    const err = new Error(message);
    EdgeRum.captureError(err, context);
  },
  time: (name, durationMs) => {
    const timer = EdgeRum.time(name);
    setTimeout(() => timer.end(), durationMs);
  },
  getSessionId: () => EdgeRum.getSessionId(),
  disable: () => EdgeRum.disable(),
  enable: () => EdgeRum.enable(),
  dispatchPagehide: () => {
    // Synthetic equivalent of LifecycleCapture's pagehide handler. The
    // capacitor package's bootstrap isn't loaded in this web-only harness,
    // so we replicate the visible behaviour here to keep the e2e focused
    // on what the wire payload looks like.
    if (appCloseFinalized) return;
    appCloseFinalized = true;
    const session = __getSession();
    const collector = __getCollector();
    if (!session || !collector) return;
    const journey = session.getJourneySnapshot();
    const oldStart = session.getStartTime();
    const oldStartMs = session.getStartTimeMs();
    const now = Date.now();
    collector.recordEvent('session.finalized', {
      'session.id': session.getSessionId(),
      'session.start_time': oldStart,
      'session.sequence': session.getSequence(),
      'session.duration_ms': Math.max(0, now - oldStartMs),
      'session.ended_at': new Date(now).toISOString(),
      'session.end_reason': 'app_closed',
      'sdk.error_count': 0,
      ...journey,
    });
  },
};

// Suppress the `__recordEvent` import being unused warning if it isn't called.
void __recordEvent;

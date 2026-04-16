import { EdgeRum } from '../packages/core/dist/index.mjs';
import type { EdgeRumConfig } from '../packages/core/dist/index.d.ts';

declare global {
  interface Window {
    __edgeRumHarness: {
      init: (config: EdgeRumConfig) => void;
      identify: Parameters<typeof EdgeRum.identify>[0] extends infer U
        ? (user: U) => void
        : never;
      track: (name: string, attrs?: Record<string, string | number | boolean>) => void;
      captureError: (message: string, context?: Record<string, unknown>) => void;
      time: (name: string, durationMs: number) => void;
      getSessionId: () => string;
      disable: () => void;
      enable: () => void;
    };
  }
}

window.__edgeRumHarness = {
  init: (config) => EdgeRum.init(config),
  identify: (user) => EdgeRum.identify(user),
  track: (name, attrs) => EdgeRum.track(name, attrs),
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
};

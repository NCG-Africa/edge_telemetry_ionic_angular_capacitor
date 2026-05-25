import type { EventAttributes } from '@nathanclaire/rum';
import { healthMonitor } from '@nathanclaire/rum';

export interface NativeCrashRecord {
  id: string;
  ts: string;
  cause: 'NativeCrash' | 'ANR' | 'Hang';
  exception_type: string;
  message: string;
  stacktrace: string;
  is_fatal: boolean;
  handled: boolean;
  runtime: 'native';
  error_context: string;
  platform: 'ios' | 'android';
  platform_version?: string;
  signal?: string;
  thread?: string;
  symbolication?: 'required' | 'symbolicated';
  'anr.duration_ms'?: number;
}

export interface NativeCrashInstallOptions {
  enableHangDetection?: boolean;
  enableAnrDetection?: boolean;
  hangTimeoutMs?: number;
  anrTimeoutMs?: number;
}

export interface EdgeRumCrashPluginLike {
  install: (opts: NativeCrashInstallOptions) => Promise<{ installed: boolean }>;
  fetchPending: () => Promise<{ crashes: NativeCrashRecord[] }>;
  markHandled: (opts: { ids: string[] }) => Promise<void>;
  setLastScreen: (opts: { screen: string }) => Promise<void>;
}

export interface NativeCrashCaptureDeps {
  recordEvent: (eventName: 'app.crash', attrs: EventAttributes) => void;
  subscribeToCurrentRoute: (cb: (route: string) => void) => () => void;
  plugin?: EdgeRumCrashPluginLike;
  loadPlugin?: () => Promise<EdgeRumCrashPluginLike | null>;
  enableAnrDetection?: boolean;
  enableHangDetection?: boolean;
  anrTimeoutMs?: number;
  hangTimeoutMs?: number;
  // Throttle window for setLastScreen relays — default 1000ms.
  screenRelayThrottleMs?: number;
  now?: () => number;
}

export interface NativeCrashCaptureHandle {
  stop: () => void;
}

const SCREEN_RELAY_THROTTLE_MS = 1000;

async function defaultLoadPlugin(): Promise<EdgeRumCrashPluginLike | null> {
  try {
    const mod = (await import('@capacitor/core')) as unknown as {
      registerPlugin: <T>(name: string) => T;
    };
    if (typeof mod.registerPlugin !== 'function') return null;
    return mod.registerPlugin<EdgeRumCrashPluginLike>('EdgeRumCrash');
  } catch (err) {
    healthMonitor.reportError('native-crash.loadPlugin', err);
    return null;
  }
}

function toAppCrashAttrs(rec: NativeCrashRecord): EventAttributes {
  const attrs: EventAttributes = {
    exception_type: rec.exception_type,
    message: rec.message,
    stacktrace: rec.stacktrace,
    is_fatal: rec.is_fatal,
    handled: rec.handled,
    error_context: rec.error_context,
    cause: rec.cause,
    runtime: rec.runtime,
    'crash.platform': rec.platform,
    'crash.id': rec.id,
    'crash.captured_at': rec.ts,
  };
  if (typeof rec.platform_version === 'string') attrs['crash.platform_version'] = rec.platform_version;
  if (typeof rec.signal === 'string') attrs['crash.signal'] = rec.signal;
  if (typeof rec.thread === 'string') attrs['crash.thread'] = rec.thread;
  if (typeof rec.symbolication === 'string') attrs['crash.symbolication'] = rec.symbolication;
  if (typeof rec['anr.duration_ms'] === 'number') attrs['anr.duration_ms'] = rec['anr.duration_ms'];
  return attrs;
}

export async function registerNativeCrashCapture(
  deps: NativeCrashCaptureDeps,
): Promise<NativeCrashCaptureHandle> {
  const loadPlugin = deps.loadPlugin ?? defaultLoadPlugin;
  const plugin = deps.plugin ?? (await loadPlugin());
  if (!plugin) {
    return { stop: () => undefined };
  }

  // 1. Install native handlers (idempotent).
  try {
    await plugin.install({
      enableHangDetection: deps.enableHangDetection ?? true,
      enableAnrDetection: deps.enableAnrDetection ?? true,
      hangTimeoutMs: deps.hangTimeoutMs,
      anrTimeoutMs: deps.anrTimeoutMs,
    });
  } catch (err) {
    healthMonitor.reportError('native-crash.install', err);
  }

  // 2. Replay any pending crashes from previous launches.
  try {
    const result = await plugin.fetchPending();
    const crashes = Array.isArray(result?.crashes) ? result.crashes : [];
    if (crashes.length > 0) {
      const handledIds: string[] = [];
      for (const rec of crashes) {
        try {
          deps.recordEvent('app.crash', toAppCrashAttrs(rec));
          handledIds.push(rec.id);
        } catch (err) {
          healthMonitor.reportError('native-crash.emit', err);
        }
      }
      if (handledIds.length > 0) {
        try {
          await plugin.markHandled({ ids: handledIds });
        } catch (err) {
          healthMonitor.reportError('native-crash.markHandled', err);
        }
      }
    }
  } catch (err) {
    healthMonitor.reportError('native-crash.fetchPending', err);
  }

  // 3. Relay current route to native so crashes carry a screen context.
  const now = deps.now ?? (() => Date.now());
  const throttleMs = deps.screenRelayThrottleMs ?? SCREEN_RELAY_THROTTLE_MS;
  let lastRelayAt = 0;
  let lastRelayed = '';
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingRoute: string | null = null;

  const sendNow = (route: string): void => {
    plugin.setLastScreen({ screen: route }).catch((err) => {
      healthMonitor.reportError('native-crash.setLastScreen', err);
    });
    lastRelayAt = now();
    lastRelayed = route;
  };

  const relay = (route: string): void => {
    if (route === lastRelayed) return;
    const elapsed = now() - lastRelayAt;
    if (elapsed >= throttleMs) {
      sendNow(route);
      return;
    }
    // Coalesce: keep the latest pending route, fire after the remaining window.
    pendingRoute = route;
    if (pendingTimer === null) {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (pendingRoute !== null && pendingRoute !== lastRelayed) {
          sendNow(pendingRoute);
        }
        pendingRoute = null;
      }, throttleMs - elapsed);
    }
  };

  const unsubscribe = deps.subscribeToCurrentRoute(relay);

  return {
    stop: () => {
      unsubscribe();
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    },
  };
}

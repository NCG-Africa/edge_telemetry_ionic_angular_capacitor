export type LifecycleAttributes = Record<string, string | number | boolean>;

export type LifecycleEvent = 'foreground' | 'background';

export const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_FLUSH_TIMEOUT_MS = 3000;

const MODULE_LOAD_TIME = Date.now();

export interface AppStateLike {
  isActive: boolean;
}

export interface AppPluginListenerHandleLike {
  remove: () => Promise<void> | void;
}

export interface AppModuleLike {
  addListener: (
    name: 'appStateChange',
    cb: (state: AppStateLike) => void,
  ) => Promise<AppPluginListenerHandleLike> | AppPluginListenerHandleLike;
}

export interface LifecycleCapacitorLike {
  isNativePlatform: () => boolean;
}

export interface LifecycleSessionManagerLike {
  getLastActiveAt: () => number;
  setLastActiveAt: (timestampMs: number) => void;
  startNewSession: () => void;
}

export interface LifecycleCaptureCallbacks {
  recordEvent: (eventName: 'app_lifecycle', attributes: LifecycleAttributes) => void;
  flushPipeline: () => Promise<void> | void;
  session: LifecycleSessionManagerLike;
}

export interface LifecycleDocumentLike {
  visibilityState?: 'visible' | 'hidden' | string;
  addEventListener?: (name: 'visibilitychange', cb: () => void) => void;
  removeEventListener?: (name: 'visibilitychange', cb: () => void) => void;
}

export interface LifecycleCaptureDeps {
  capacitor?: LifecycleCapacitorLike;
  loadApp?: () => Promise<AppModuleLike>;
  getDocument?: () => LifecycleDocumentLike | undefined;
  now?: () => number;
  moduleLoadTime?: number;
  sessionTimeoutMs?: number;
  flushTimeoutMs?: number;
}

export interface LifecycleCaptureHandle {
  stop: () => Promise<void>;
}

function defaultCapacitor(): LifecycleCapacitorLike {
  const g = globalThis as unknown as { Capacitor?: LifecycleCapacitorLike };
  if (g.Capacitor && typeof g.Capacitor.isNativePlatform === 'function') {
    return g.Capacitor;
  }
  return { isNativePlatform: () => false };
}

function defaultLoadApp(): () => Promise<AppModuleLike> {
  return async () => {
    const mod = (await import('@capacitor/app')) as unknown as { App: AppModuleLike };
    return mod.App;
  };
}

function defaultDocument(): LifecycleDocumentLike | undefined {
  return typeof document !== 'undefined' ? (document as unknown as LifecycleDocumentLike) : undefined;
}

export async function startLifecycleCapture(
  callbacks: LifecycleCaptureCallbacks,
  deps: LifecycleCaptureDeps = {},
): Promise<LifecycleCaptureHandle> {
  const capacitor = deps.capacitor ?? defaultCapacitor();
  const loadApp = deps.loadApp ?? defaultLoadApp();
  const getDocument = deps.getDocument ?? defaultDocument;
  const now = deps.now ?? (() => Date.now());
  const moduleLoadTime = deps.moduleLoadTime ?? MODULE_LOAD_TIME;
  const sessionTimeoutMs = deps.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const flushTimeoutMs = deps.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;

  let firstForeground = true;

  const handleForeground = (): void => {
    const ts = now();
    const lastActiveAt = callbacks.session.getLastActiveAt();
    if (lastActiveAt > 0 && ts - lastActiveAt > sessionTimeoutMs) {
      callbacks.session.startNewSession();
    }
    const attrs: LifecycleAttributes = { 'lifecycle.event': 'foreground' };
    if (firstForeground) {
      attrs['lifecycle.cold_start_ms'] = ts - moduleLoadTime;
      firstForeground = false;
    }
    callbacks.recordEvent('app_lifecycle', attrs);
  };

  const handleBackground = (): void => {
    const ts = now();
    callbacks.session.setLastActiveAt(ts);
    callbacks.recordEvent('app_lifecycle', { 'lifecycle.event': 'background' });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const flushed = (async () => {
      try {
        await callbacks.flushPipeline();
      } catch {
        // best-effort
      }
    })();
    const timed = new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, flushTimeoutMs);
    });
    void Promise.race([flushed, timed]).then(() => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    });
  };

  const handleAppState = (state: AppStateLike): void => {
    if (state.isActive) {
      handleForeground();
    } else {
      handleBackground();
    }
  };

  const isNative = (() => {
    try {
      return capacitor.isNativePlatform();
    } catch {
      return false;
    }
  })();

  let nativeHandle: AppPluginListenerHandleLike | undefined;
  let doc: LifecycleDocumentLike | undefined;
  let visibilityListener: (() => void) | undefined;

  if (isNative) {
    try {
      const app = await loadApp();
      const maybeHandle = app.addListener('appStateChange', handleAppState);
      nativeHandle = await Promise.resolve(maybeHandle);
    } catch {
      // fall through to web listener
    }
  }

  if (!nativeHandle) {
    doc = getDocument();
    if (doc && typeof doc.addEventListener === 'function') {
      visibilityListener = (): void => {
        if (doc?.visibilityState === 'hidden') {
          handleBackground();
        } else if (doc?.visibilityState === 'visible') {
          handleForeground();
        }
      };
      doc.addEventListener('visibilitychange', visibilityListener);
    }
  }

  return {
    stop: async () => {
      if (nativeHandle) {
        try {
          await nativeHandle.remove();
        } catch {
          // ignore
        }
      }
      if (doc && visibilityListener && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('visibilitychange', visibilityListener);
      }
    },
  };
}

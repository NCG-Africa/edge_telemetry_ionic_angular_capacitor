export type LifecycleAttributes = Record<string, string | number | boolean>;

export type LifecycleEvent = 'foreground' | 'background';

export const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_FLUSH_TIMEOUT_MS = 3000;
export const DEFAULT_BEACON_XHR_TIMEOUT_MS = 1000;

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

export interface BeaconPayload {
  url: string;
  body: string;
  headers?: Record<string, string>;
}

export interface LifecycleCaptureCallbacks {
  recordEvent: (eventName: 'app_lifecycle', attributes: LifecycleAttributes) => void;
  flushPipeline: () => Promise<void> | void;
  session: LifecycleSessionManagerLike;
  getBeaconPayload?: () => BeaconPayload | null;
  getPlatform?: () => string;
}

export interface LifecycleDocumentLike {
  visibilityState?: 'visible' | 'hidden' | string;
  addEventListener?: (name: 'visibilitychange', cb: () => void) => void;
  removeEventListener?: (name: 'visibilitychange', cb: () => void) => void;
}

export interface BeaconNavigatorLike {
  sendBeacon?: (url: string, data?: BodyInit | null) => boolean;
}

export interface XhrLike {
  open: (method: string, url: string, async: boolean) => void;
  setRequestHeader: (name: string, value: string) => void;
  send: (body?: string) => void;
  timeout?: number;
}

export interface LifecycleWindowLike {
  addEventListener?: (name: 'beforeunload' | 'pagehide', cb: () => void) => void;
  removeEventListener?: (name: 'beforeunload' | 'pagehide', cb: () => void) => void;
}

export interface LifecycleCaptureDeps {
  capacitor?: LifecycleCapacitorLike;
  loadApp?: () => Promise<AppModuleLike>;
  getDocument?: () => LifecycleDocumentLike | undefined;
  getWindow?: () => LifecycleWindowLike | undefined;
  getNavigator?: () => BeaconNavigatorLike | undefined;
  createXhr?: () => XhrLike;
  now?: () => number;
  moduleLoadTime?: number;
  sessionTimeoutMs?: number;
  flushTimeoutMs?: number;
  beaconXhrTimeoutMs?: number;
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
    const plugin = mod.App;
    // Capacitor 8 proxies have a .then() that throws on Android.
    // Return a plain object so `await` won't treat it as a thenable.
    return {
      addListener: (name, cb) => plugin.addListener(name, cb),
    };
  };
}

function defaultDocument(): LifecycleDocumentLike | undefined {
  return typeof document !== 'undefined' ? (document as unknown as LifecycleDocumentLike) : undefined;
}

function defaultWindow(): LifecycleWindowLike | undefined {
  return typeof window !== 'undefined' ? (window as unknown as LifecycleWindowLike) : undefined;
}

function defaultNavigator(): BeaconNavigatorLike | undefined {
  return typeof navigator !== 'undefined' ? (navigator as unknown as BeaconNavigatorLike) : undefined;
}

function defaultCreateXhr(): XhrLike {
  return new XMLHttpRequest() as unknown as XhrLike;
}

export async function startLifecycleCapture(
  callbacks: LifecycleCaptureCallbacks,
  deps: LifecycleCaptureDeps = {},
): Promise<LifecycleCaptureHandle> {
  const capacitor = deps.capacitor ?? defaultCapacitor();
  const loadApp = deps.loadApp ?? defaultLoadApp();
  const getDocument = deps.getDocument ?? defaultDocument;
  const getWindow = deps.getWindow ?? defaultWindow;
  const getNavigator = deps.getNavigator ?? defaultNavigator;
  const createXhr = deps.createXhr ?? defaultCreateXhr;
  const now = deps.now ?? (() => Date.now());
  const moduleLoadTime = deps.moduleLoadTime ?? MODULE_LOAD_TIME;
  const sessionTimeoutMs = deps.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const flushTimeoutMs = deps.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  const beaconXhrTimeoutMs = deps.beaconXhrTimeoutMs ?? DEFAULT_BEACON_XHR_TIMEOUT_MS;

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

  const sendBeaconPayload = (): void => {
    const getPayload = callbacks.getBeaconPayload;
    if (!getPayload) return;
    let payload: BeaconPayload | null;
    try {
      payload = getPayload();
    } catch {
      return;
    }
    if (!payload || typeof payload.body !== 'string' || payload.body.length === 0) return;

    const platform = (() => {
      try {
        return callbacks.getPlatform ? callbacks.getPlatform() : '';
      } catch {
        return '';
      }
    })();

    if (platform === 'ios') {
      try {
        const xhr = createXhr();
        xhr.open('POST', payload.url, false);
        xhr.setRequestHeader('Content-Type', 'application/json');
        if (payload.headers) {
          for (const [name, value] of Object.entries(payload.headers)) {
            xhr.setRequestHeader(name, value);
          }
        }
        if ('timeout' in xhr) xhr.timeout = beaconXhrTimeoutMs;
        xhr.send(payload.body);
      } catch {
        // best-effort
      }
      return;
    }

    const nav = getNavigator();
    if (nav && typeof nav.sendBeacon === 'function') {
      try {
        const blob = typeof Blob !== 'undefined'
          ? new Blob([payload.body], { type: 'application/json' })
          : payload.body;
        nav.sendBeacon(payload.url, blob as BodyInit);
        return;
      } catch {
        // fall through to sync XHR
      }
    }

    try {
      const xhr = createXhr();
      xhr.open('POST', payload.url, false);
      xhr.setRequestHeader('Content-Type', 'application/json');
      if (payload.headers) {
        for (const [name, value] of Object.entries(payload.headers)) {
          xhr.setRequestHeader(name, value);
        }
      }
      if ('timeout' in xhr) xhr.timeout = beaconXhrTimeoutMs;
      xhr.send(payload.body);
    } catch {
      // best-effort
    }
  };

  let nativeHandle: AppPluginListenerHandleLike | undefined;
  let doc: LifecycleDocumentLike | undefined;
  let visibilityListener: (() => void) | undefined;
  let beforeUnloadListener: (() => void) | undefined;

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

  const win = getWindow();
  if (win && typeof win.addEventListener === 'function') {
    beforeUnloadListener = (): void => {
      sendBeaconPayload();
    };
    win.addEventListener('beforeunload', beforeUnloadListener);
    win.addEventListener('pagehide', beforeUnloadListener);
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
      if (win && beforeUnloadListener && typeof win.removeEventListener === 'function') {
        win.removeEventListener('beforeunload', beforeUnloadListener);
        win.removeEventListener('pagehide', beforeUnloadListener);
      }
    },
  };
}

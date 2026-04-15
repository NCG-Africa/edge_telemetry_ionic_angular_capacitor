export type NetworkConnectionType = 'wifi' | 'cellular' | 'none' | 'unknown';

export type NetworkAttributes = Record<string, string | number | boolean>;

export interface NetworkStatusLike {
  connected: boolean;
  connectionType: NetworkConnectionType | string;
}

export interface PluginListenerHandleLike {
  remove: () => Promise<void> | void;
}

export interface NetworkModuleLike {
  getStatus: () => Promise<NetworkStatusLike>;
  addListener: (
    name: 'networkStatusChange',
    cb: (status: NetworkStatusLike) => void,
  ) => Promise<PluginListenerHandleLike> | PluginListenerHandleLike;
}

export interface NetworkCapacitorLike {
  isNativePlatform: () => boolean;
}

export interface NavigatorConnectionLike {
  type?: string;
  effectiveType?: string;
  downlink?: number;
  addEventListener?: (name: 'change', cb: () => void) => void;
  removeEventListener?: (name: 'change', cb: () => void) => void;
}

export interface NavigatorWithConnection {
  onLine?: boolean;
  connection?: NavigatorConnectionLike;
}

export interface NetworkCaptureCallbacks {
  setOnline: (online: boolean) => void;
  flushQueue: () => void | Promise<void>;
  recordEvent: (eventName: 'network_change', attributes: NetworkAttributes) => void;
}

export interface NetworkCaptureDeps {
  capacitor?: NetworkCapacitorLike;
  loadNetwork?: () => Promise<NetworkModuleLike>;
  getNavigator?: () => NavigatorWithConnection | undefined;
  getWindow?: () => (Window & typeof globalThis) | undefined;
}

export interface NetworkCaptureHandle {
  stop: () => Promise<void>;
}

function defaultCapacitor(): NetworkCapacitorLike {
  const g = globalThis as unknown as { Capacitor?: NetworkCapacitorLike };
  if (g.Capacitor && typeof g.Capacitor.isNativePlatform === 'function') {
    return g.Capacitor;
  }
  return { isNativePlatform: () => false };
}

function defaultLoadNetwork(): () => Promise<NetworkModuleLike> {
  return async () => {
    const mod = (await import('@capacitor/network')) as unknown as { Network: NetworkModuleLike };
    return mod.Network;
  };
}

function defaultNavigator(): NavigatorWithConnection | undefined {
  return typeof navigator !== 'undefined' ? (navigator as unknown as NavigatorWithConnection) : undefined;
}

function defaultWindow(): (Window & typeof globalThis) | undefined {
  return typeof window !== 'undefined' ? window : undefined;
}

function normaliseType(raw: string | undefined): NetworkConnectionType {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase();
  if (lower === 'wifi') return 'wifi';
  if (lower === 'cellular' || lower === '2g' || lower === '3g' || lower === '4g' || lower === '5g') {
    return 'cellular';
  }
  if (lower === 'none') return 'none';
  if (lower === 'wifi' || lower === 'ethernet' || lower === 'bluetooth') {
    return lower === 'wifi' ? 'wifi' : 'unknown';
  }
  return 'unknown';
}

function addConnectionDetails(
  attrs: NetworkAttributes,
  nav: NavigatorWithConnection | undefined,
): void {
  const conn = nav?.connection;
  if (!conn) return;
  if (typeof conn.effectiveType === 'string' && conn.effectiveType.length > 0) {
    attrs['network.effectiveType'] = conn.effectiveType;
  }
  if (typeof conn.downlink === 'number' && Number.isFinite(conn.downlink)) {
    attrs['network.downlinkMbps'] = conn.downlink;
  }
}

export async function getInitialNetworkContext(
  deps: NetworkCaptureDeps = {},
): Promise<NetworkAttributes> {
  const capacitor = deps.capacitor ?? defaultCapacitor();
  const nav = deps.getNavigator ? deps.getNavigator() : defaultNavigator();
  const loadNetwork = deps.loadNetwork ?? defaultLoadNetwork();

  const attrs: NetworkAttributes = {};
  let connected = true;
  let type: NetworkConnectionType = 'unknown';

  const isNative = (() => {
    try {
      return capacitor.isNativePlatform();
    } catch {
      return false;
    }
  })();

  if (isNative) {
    try {
      const network = await loadNetwork();
      const status = await network.getStatus();
      connected = status.connected;
      type = normaliseType(status.connectionType);
    } catch {
      // fall back to navigator-derived values
    }
  } else {
    if (nav && typeof nav.onLine === 'boolean') {
      connected = nav.onLine;
    }
    const connType = nav?.connection?.type;
    if (typeof connType === 'string') {
      type = normaliseType(connType);
    } else if (connected) {
      type = 'unknown';
    } else {
      type = 'none';
    }
  }

  attrs['network.connected'] = connected;
  attrs['network.type'] = type;
  addConnectionDetails(attrs, nav);
  return attrs;
}

export async function startNetworkCapture(
  callbacks: NetworkCaptureCallbacks,
  deps: NetworkCaptureDeps = {},
): Promise<NetworkCaptureHandle> {
  const capacitor = deps.capacitor ?? defaultCapacitor();
  const nav = deps.getNavigator ? deps.getNavigator() : defaultNavigator();
  const win = deps.getWindow ? deps.getWindow() : defaultWindow();
  const loadNetwork = deps.loadNetwork ?? defaultLoadNetwork();

  const initial = await getInitialNetworkContext(deps);
  let previousType = String(initial['network.type'] ?? 'unknown');
  let previousConnected = Boolean(initial['network.connected']);

  const handleStatus = (status: NetworkStatusLike): void => {
    const nextType = normaliseType(status.connectionType);
    const nextConnected = status.connected;

    const attrs: NetworkAttributes = {
      'network.connected': nextConnected,
      'network.type': nextType,
      'network.previous_type': previousType,
    };
    addConnectionDetails(attrs, nav);

    if (!nextConnected && previousConnected) {
      callbacks.setOnline(false);
    } else if (nextConnected && !previousConnected) {
      callbacks.setOnline(true);
      try {
        const maybe = callbacks.flushQueue();
        if (maybe && typeof (maybe as Promise<void>).catch === 'function') {
          (maybe as Promise<void>).catch(() => {
            // swallow — flush is best-effort
          });
        }
      } catch {
        // swallow — flush is best-effort
      }
    }

    callbacks.recordEvent('network_change', attrs);

    previousType = nextType;
    previousConnected = nextConnected;
  };

  const isNative = (() => {
    try {
      return capacitor.isNativePlatform();
    } catch {
      return false;
    }
  })();

  let nativeHandle: PluginListenerHandleLike | undefined;
  let webOnlineListener: (() => void) | undefined;
  let webOfflineListener: (() => void) | undefined;
  let connectionChangeListener: (() => void) | undefined;

  if (isNative) {
    try {
      const network = await loadNetwork();
      const maybeHandle = network.addListener('networkStatusChange', handleStatus);
      nativeHandle = await Promise.resolve(maybeHandle);
    } catch {
      // fall through to web listeners if native listener setup fails
    }
  }

  if (!nativeHandle && win) {
    const readStatus = (): NetworkStatusLike => {
      const connected = typeof nav?.onLine === 'boolean' ? nav.onLine : true;
      const rawType = nav?.connection?.type;
      const connectionType = typeof rawType === 'string'
        ? rawType
        : (connected ? 'unknown' : 'none');
      return { connected, connectionType };
    };

    webOnlineListener = (): void => handleStatus(readStatus());
    webOfflineListener = (): void => handleStatus({ ...readStatus(), connected: false });
    win.addEventListener('online', webOnlineListener);
    win.addEventListener('offline', webOfflineListener);

    const conn = nav?.connection;
    if (conn && typeof conn.addEventListener === 'function') {
      connectionChangeListener = (): void => handleStatus(readStatus());
      conn.addEventListener('change', connectionChangeListener);
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
      if (win && webOnlineListener) {
        win.removeEventListener('online', webOnlineListener);
      }
      if (win && webOfflineListener) {
        win.removeEventListener('offline', webOfflineListener);
      }
      const conn = nav?.connection;
      if (conn && connectionChangeListener && typeof conn.removeEventListener === 'function') {
        conn.removeEventListener('change', connectionChangeListener);
      }
    },
  };
}

export const __internal = {
  normaliseType,
};

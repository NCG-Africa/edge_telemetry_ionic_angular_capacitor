import { __getSession, __getCollector, __getContext, __getPipeline, __setTransportFetch } from '@nathanclaire/rum';
import { getDeviceContext } from './DeviceContext';
import { startNetworkCapture, getInitialNetworkContext } from './NetworkCapture';
import { startLifecycleCapture } from './LifecycleCapture';
import { createCapacitorHttpFetch, type CapacitorLike } from './capacitor-http-fetch';

export interface CapacitorCaptureHandle {
  stop: () => Promise<void>;
}

interface AppInfoLike {
  build: string;
}

interface AppGetInfoLike {
  getInfo: () => Promise<AppInfoLike>;
}

function detectNativePlatform(): boolean {
  const g = globalThis as unknown as { Capacitor?: CapacitorLike };
  return !!(g.Capacitor && typeof g.Capacitor.isNativePlatform === 'function' && g.Capacitor.isNativePlatform());
}

async function loadNativeAppBuild(): Promise<string | null> {
  try {
    const mod = (await import('@capacitor/app')) as unknown as { App: AppGetInfoLike };
    // Capacitor 8 proxies have a .then() that throws on Android.
    // Return a plain object so `await` won't treat it as a thenable.
    const plugin: AppGetInfoLike = { getInfo: () => mod.App.getInfo() };
    const info = await plugin.getInfo();
    return typeof info.build === 'string' ? info.build : null;
  } catch {
    return null;
  }
}

export async function startCapacitorCapture(): Promise<CapacitorCaptureHandle> {
  const session = __getSession();
  const collector = __getCollector();
  const context = __getContext();
  const pipeline = __getPipeline();

  if (!session || !collector || !context || !pipeline) {
    throw new Error('edge-rum: init() must be called before startCapacitorCapture()');
  }

  const isNative = detectNativePlatform();

  if (isNative) {
    try {
      __setTransportFetch(createCapacitorHttpFetch());
    } catch {
      // Fall through to default fetch transport.
    }
  }

  const deviceAttrs = await getDeviceContext();
  context.setDeviceAttributes(deviceAttrs);

  if (isNative) {
    const build = await loadNativeAppBuild();
    if (build !== null) {
      context.setAppBuildNumber(build);
    }
  }

  const networkAttrs = await getInitialNetworkContext();
  context.setNetworkAttributes(networkAttrs);

  pipeline.markReady();

  const networkHandle = await startNetworkCapture({
    recordEvent: (eventName, attrs) => collector.recordEvent(eventName, attrs),
    setOnline: (online: boolean) => {
      if (online) {
        void pipeline.flushOfflineQueue();
      }
    },
    flushQueue: () => void pipeline.flush(),
  });

  const lifecycleHandle = await startLifecycleCapture({
    recordEvent: (eventName, attrs) => collector.recordEvent(eventName, attrs),
    flushPipeline: () => pipeline.flush(),
    session,
  });

  return {
    stop: async () => {
      await networkHandle.stop();
      await lifecycleHandle.stop();
    },
  };
}

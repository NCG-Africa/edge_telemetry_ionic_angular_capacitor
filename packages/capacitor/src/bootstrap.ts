import { __getSession, __getCollector, __getContext, __getPipeline } from '@edgemetrics/rum';
import { getDeviceContext } from './DeviceContext';
import { startNetworkCapture, getInitialNetworkContext } from './NetworkCapture';
import { startLifecycleCapture } from './LifecycleCapture';

export interface CapacitorCaptureHandle {
  stop: () => Promise<void>;
}

export async function startCapacitorCapture(): Promise<CapacitorCaptureHandle> {
  const session = __getSession();
  const collector = __getCollector();
  const context = __getContext();
  const pipeline = __getPipeline();

  if (!session || !collector || !context || !pipeline) {
    throw new Error('edge-rum: init() must be called before startCapacitorCapture()');
  }

  const deviceAttrs = await getDeviceContext();
  context.setDeviceAttributes(deviceAttrs);

  const networkAttrs = await getInitialNetworkContext();
  context.setNetworkAttributes(networkAttrs);

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

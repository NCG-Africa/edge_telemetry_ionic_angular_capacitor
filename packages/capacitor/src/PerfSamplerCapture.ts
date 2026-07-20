import type { EventAttributes } from '@nathanclaire/rum';
import { healthMonitor } from '@nathanclaire/rum';
import {
  loadEdgeRumCrashPlugin,
  type EdgeRumCrashPluginLike,
  type NativeFrameSummary,
  type NativeMemorySample,
} from './NativeCrashCapture';

export interface PerfSamplerCaptureOptions {
  captureFrames?: boolean;
  captureMemory?: boolean;
  memorySamplingIntervalMs?: number;
  frameSlowThresholdMs?: number;
  captureAllFrames?: boolean;
  drainIntervalMs?: number;
}

export interface PerfSamplerCaptureDeps {
  recordMetric: (metricName: string, value: number, attributes: EventAttributes) => void;
  options?: PerfSamplerCaptureOptions;
  plugin?: EdgeRumCrashPluginLike;
  loadPlugin?: () => Promise<EdgeRumCrashPluginLike | null>;
  // Test seams
  setInterval?: (cb: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface PerfSamplerCaptureHandle {
  stop: () => Promise<void>;
  drainNow: () => Promise<void>;
}

const DEFAULT_DRAIN_INTERVAL_MS = 5000;

function defaultSetInterval(cb: () => void, ms: number): unknown {
  return setInterval(cb, ms);
}

function defaultClearInterval(handle: unknown): void {
  clearInterval(handle as ReturnType<typeof setInterval>);
}

// Dotless summary attrs matching the web frame shape (ADR-030). `value` (p95)
// is passed as the top-level metric value, not repeated here.
function frameSummaryToAttrs(s: NativeFrameSummary): EventAttributes {
  return {
    frames_total: s.frames_total,
    slow_frames: s.slow_frames,
    dropped_frames: s.dropped_frames,
    p50_ms: s.p50_ms,
    p95_ms: s.p95_ms,
    worst_ms: s.worst_ms,
    window_ms: s.window_ms,
    'metric.screen': s.screen,
  };
}

function memorySampleToAttrs(s: NativeMemorySample): EventAttributes {
  const attrs: EventAttributes = {
    unit: 'MB',
    memory_type: s.type,
    memory_source: s.source,
  };
  // `memory_pressure_level` is intentionally omitted when the native side
  // can't determine it — sending an empty string would cause the processor
  // to bucket samples under a bogus "" pressure value.
  if (typeof s.pressure === 'string' && s.pressure.length > 0) {
    attrs.memory_pressure_level = s.pressure;
  }
  return attrs;
}

export async function startPerfSamplerCapture(
  deps: PerfSamplerCaptureDeps,
): Promise<PerfSamplerCaptureHandle> {
  const options = deps.options ?? {};
  const captureFrames = options.captureFrames !== false;
  const captureMemory = options.captureMemory !== false;
  const drainIntervalMs = options.drainIntervalMs ?? DEFAULT_DRAIN_INTERVAL_MS;
  const intervalSetter = deps.setInterval ?? defaultSetInterval;
  const intervalClearer = deps.clearInterval ?? defaultClearInterval;

  if (!captureFrames && !captureMemory) {
    return {
      stop: async () => undefined,
      drainNow: async () => undefined,
    };
  }

  const loader = deps.loadPlugin ?? loadEdgeRumCrashPlugin;
  const plugin = deps.plugin ?? (await loader());
  if (!plugin) {
    return {
      stop: async () => undefined,
      drainNow: async () => undefined,
    };
  }

  try {
    await plugin.startPerfSampling({
      memoryIntervalMs: options.memorySamplingIntervalMs,
      captureFrames,
      captureMemory,
      frameSlowThresholdMs: options.frameSlowThresholdMs,
      captureAllFrames: options.captureAllFrames === true,
    });
  } catch (err) {
    healthMonitor.reportError('perf-sampler.start', err);
  }

  let stopped = false;

  const drainFrames = async (): Promise<void> => {
    if (!captureFrames || stopped) return;
    try {
      const result = await plugin.fetchFrameSamples();
      const frames = Array.isArray(result?.frames) ? result.frames : [];
      for (const frame of frames) {
        try {
          deps.recordMetric('frame_render_time', frame.value, frameSummaryToAttrs(frame));
        } catch (err) {
          healthMonitor.reportError('perf-sampler.frame.emit', err);
        }
      }
    } catch (err) {
      healthMonitor.reportError('perf-sampler.frame.fetch', err);
    }
  };

  const drainMemory = async (): Promise<void> => {
    if (!captureMemory || stopped) return;
    try {
      const result = await plugin.fetchMemorySamples();
      const samples = Array.isArray(result?.samples) ? result.samples : [];
      for (const sample of samples) {
        try {
          deps.recordMetric('memory_usage', sample.value_mb, memorySampleToAttrs(sample));
        } catch (err) {
          healthMonitor.reportError('perf-sampler.memory.emit', err);
        }
      }
    } catch (err) {
      healthMonitor.reportError('perf-sampler.memory.fetch', err);
    }
  };

  const drainNow = async (): Promise<void> => {
    await Promise.all([drainFrames(), drainMemory()]);
  };

  const handle = intervalSetter(() => {
    void drainNow();
  }, drainIntervalMs);

  return {
    stop: async (): Promise<void> => {
      // Clear the interval first so no new tick can race the final drain, but
      // keep `stopped` false until after the drain so drainNow's stopped-guard
      // doesn't short-circuit the final shipment.
      intervalClearer(handle);
      try {
        await drainNow();
      } catch {
        // best-effort
      }
      stopped = true;
      try {
        await plugin.stopPerfSampling();
      } catch (err) {
        healthMonitor.reportError('perf-sampler.stop', err);
      }
    },
    drainNow,
  };
}

import {
  __childSpan,
  __getCurrentRoute,
  __onRouteChange,
  __recordEvent,
  defaultCaptures as coreDefaults,
  type Capture,
  type EventAttributes,
} from '@nathanclaire/rum';

type NativePromise = (plugin: string, method: string, options?: unknown) => unknown;
interface Group { service: string; action: string; ms: number[]; errors: number; codes: Set<string>; span?: EventAttributes; start: number; end: number }

// ponytail: nearest-rank, no interpolation; windows hold few calls, so the gap rarely shows.
const percentile = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;

/** P5: the error's code, else its class. Never its message. */
function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code) return code;
  const name = (e as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name ? name : 'unknown';
}

/**
 * Native plugin call timings (E18). Wraps `Capacitor.nativePromise`, which every promise-style
 * plugin method goes through at call time, and sends one `bridge.summary` per plugin + method
 * per screen window. Calls under a live trace root are its child span (X6).
 */
export const bridge = (): Capture => ({
  name: 'bridge',
  start: () => {
    const cap = (globalThis as { Capacitor?: { nativePromise?: NativePromise } }).Capacitor;
    const original = cap?.nativePromise;
    if (!cap || typeof original !== 'function') return;
    const groups = new Map<string, Group>();

    const done = (g: Group, t0: number, ok: boolean, err?: unknown) => {
      const t = performance.now();
      g.ms.push(t - t0);
      g.end = Math.max(g.end, t);
      if (!ok) {
        g.errors++;
        g.codes.add(errorCode(err));
      }
    };

    const wrapped: NativePromise = function (this: unknown, plugin, method, options) {
      // The SDK's own plugin is never timed (E18).
      if (plugin === 'EdgeRum') return original.call(this, plugin, method, options);
      let g: Group | undefined;
      let t0 = 0;
      try {
        t0 = performance.now();
        const span = __childSpan();
        // One row per root: its keys belong to the calls made under it.
        const key = `${String(span?.['parent.span.id'] ?? '')}\n${plugin}\n${method}`;
        g = groups.get(key);
        if (!g) groups.set(key, (g = { service: String(plugin), action: String(method), ms: [], errors: 0, codes: new Set(), span, start: t0, end: t0 }));
      } catch {
        // Never break the app's plugin call.
      }
      const p = original.call(this, plugin, method, options);
      // Observe only: the caller keeps the original promise, rejection and all.
      if (g && p && typeof (p as Promise<unknown>).then === 'function') {
        const grp = g;
        (p as Promise<unknown>).then(() => done(grp, t0, true), (e: unknown) => done(grp, t0, false, e));
      }
      return p;
    };

    const endWindow = () => {
      const screen = __getCurrentRoute();
      for (const g of groups.values()) {
        const ms = g.ms.sort((a, b) => a - b);
        // ponytail: a call still in flight when its window closes is not counted.
        if (!ms.length) continue;
        __recordEvent('bridge.summary', {
          'screen.name': screen,
          'bridge.service': g.service,
          'bridge.action': g.action,
          'bridge.count': ms.length,
          'bridge.error_count': g.errors,
          'bridge.p50_ms': Math.round(percentile(ms, 0.5)),
          'bridge.p95_ms': Math.round(percentile(ms, 0.95)),
          'bridge.max_ms': Math.round(ms[ms.length - 1] ?? 0),
          ...(g.codes.size && { 'bridge.error_codes': [...g.codes].sort().join(',') }),
          ...(g.span && { ...g.span, 'span.duration_ms': Math.round(g.end - g.start) }),
        });
      }
      groups.clear();
    };
    // Before core's own hidden hand-off (captures start first), so the rows ride it.
    const onHidden = () => {
      if (document.visibilityState === 'hidden') endWindow();
    };

    cap.nativePromise = wrapped;
    const offRoute = __onRouteChange(endWindow);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      endWindow();
      offRoute();
      document.removeEventListener('visibilitychange', onHidden);
      if (cap.nativePromise === wrapped) cap.nativePromise = original;
    };
  },
});

/** The standard set: vitals, interactions, frames, long tasks, console errors, native plugin calls. */
export const defaultCaptures = (): Capture[] => [...coreDefaults(), bridge()];

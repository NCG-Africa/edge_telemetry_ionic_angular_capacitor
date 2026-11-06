import { EdgeRum } from '@nathanclaire/rum';

type Row = { eventName?: string; attributes: Record<string, unknown> };

/**
 * Spec Q1: a fake Capacitor bridge so the core is live in Node. Call at module top level,
 * before any test runs; `handedOff()` forces a hand-off and returns (then forgets) what native got.
 */
export function fakeNative(): { handedOff: () => Promise<Row[]> } {
  let rows: Row[] = [];
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const g = globalThis as Record<string, unknown>;
  g.document ??= doc;
  const plugin = new Proxy({}, {
    get: (_, m) => (arg: { events?: Row[] }) => {
      if (m === 'getState') return Promise.resolve({ enabled: true, sessionId: 's1' });
      if (m === 'enqueue') rows.push(...(arg.events ?? []));
      return Promise.resolve({});
    },
  });
  g.Capacitor = { isNativePlatform: () => true, registerPlugin: () => plugin };
  EdgeRum.init({ captures: [] });
  return {
    async handedOff() {
      const d = g.document as EventTarget;
      // defineProperty: a real DOM (happy-dom) has a getter-only `visibilityState`.
      const set = (value: string) => Object.defineProperty(d, 'visibilityState', { value, configurable: true });
      set('hidden');
      d.dispatchEvent(new Event('visibilitychange'));
      set('visible');
      await new Promise((r) => setTimeout(r, 0));
      const out = rows;
      rows = [];
      return out;
    },
  };
}

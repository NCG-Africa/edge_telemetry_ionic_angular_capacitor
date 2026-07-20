import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OfflineQueue,
  OFFLINE_QUEUE_KEY,
  createDefaultStorage,
  type DrainSender,
  type PreferencesLike,
  type QueueStorage,
} from '../src/queue/OfflineQueue';
import type { SendResult } from '../src/transport/RetryTransport';
import { healthMonitor } from '../src/internal/health';

// Sender that records every payload it sees and always succeeds.
function recordingOkSender(sent: string[]): DrainSender {
  return async (p) => {
    sent.push(p);
    return { status: 'ok' };
  };
}

// Drain the queue with a given sender and wait for the pass to settle. The
// drain runs items back-to-back on real timers; poll until it stops sending.
async function drainAndSettle(queue: OfflineQueue, sender: DrainSender, onSuccess?: () => void): Promise<void> {
  queue.setDrainSender(sender, onSuccess);
  queue.poke();
  // Let the (immediate-resolving) send/save microtasks flush.
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

class MemoryStorage implements QueueStorage {
  items: string[] = [];
  loads = 0;
  saves = 0;
  async load(): Promise<string[]> {
    this.loads++;
    return [...this.items];
  }
  async save(next: string[]): Promise<void> {
    this.saves++;
    this.items = [...next];
  }
}

function fakeLocalStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  } satisfies Storage;
}

function fakePreferences(initial: string | null = null): PreferencesLike & { store: { value: string | null } } {
  const store = { value: initial };
  return {
    store,
    get: async ({ key }) => ({ value: key === OFFLINE_QUEUE_KEY ? store.value : null }),
    set: async ({ key, value }) => {
      if (key === OFFLINE_QUEUE_KEY) store.value = value;
    },
    remove: async ({ key }) => {
      if (key === OFFLINE_QUEUE_KEY) store.value = null;
    },
  };
}

const batchPayload = (i: number): string =>
  JSON.stringify({
    type: 'telemetry_batch',
    timestamp: `2024-01-15T10:30:0${i % 10}.000Z`,
    events: [
      {
        type: 'event',
        eventName: 'custom_event',
        timestamp: `2024-01-15T10:30:0${i % 10}.000Z`,
        attributes: {
          'session.id': 'session_1_aaaaaaaa_web',
          'device.id': 'device_1_aaaaaaaa_web',
          'sdk.platform': 'ionic-angular-capacitor',
          'event.name': `checkout_${i}`,
          'event.value': i,
        },
      },
    ],
  });

describe('OfflineQueue', () => {
  let storage: MemoryStorage;
  let queue: OfflineQueue;

  beforeEach(() => {
    storage = new MemoryStorage();
    queue = new OfflineQueue({ storage, maxQueueSize: 200 });
  });

  it('push 250 items with cap 200 drops the oldest 50 (FIFO)', async () => {
    for (let i = 0; i < 250; i++) {
      await queue.push(`item-${i}`);
    }
    expect(await queue.size()).toBe(200);
    expect(storage.items.length).toBe(200);
    expect(storage.items[0]).toBe('item-50');
    expect(storage.items[199]).toBe('item-249');
  });

  it('a retryable result keeps the item and stops the pass (does not skip to later items)', async () => {
    await queue.push('a');
    await queue.push('b');
    await queue.push('c');

    const sent: string[] = [];
    const sender = vi.fn(async (payload: string): Promise<SendResult> => {
      sent.push(payload);
      return payload === 'b' ? { status: 'retryable' } : { status: 'ok' };
    });

    await drainAndSettle(queue, sender);

    // 'a' delivered, 'b' retryable → drain holds at 'b'; 'c' is not attempted.
    expect(sent).toEqual(['a', 'b']);
    expect(await queue.size()).toBe(2);
    expect(storage.items).toEqual(['b', 'c']);
  });

  it('an all-ok drain empties the queue completely, contiguously', async () => {
    for (let i = 0; i < 5; i++) await queue.push(`p-${i}`);
    const sent: string[] = [];
    await drainAndSettle(queue, recordingOkSender(sent));
    expect(sent).toEqual(['p-0', 'p-1', 'p-2', 'p-3', 'p-4']);
    expect(await queue.size()).toBe(0);
    expect(storage.items).toEqual([]);
  });

  it('clear() empties the queue', async () => {
    await queue.push('a');
    await queue.push('b');
    await queue.clear();
    expect(await queue.size()).toBe(0);
    expect(storage.items).toEqual([]);
  });

  it('size() reflects current queue length', async () => {
    expect(await queue.size()).toBe(0);
    await queue.push('a');
    expect(await queue.size()).toBe(1);
    await queue.push('b');
    expect(await queue.size()).toBe(2);
  });

  it('hydrates from existing persisted items on first use', async () => {
    storage.items = ['persisted-1', 'persisted-2'];
    const q = new OfflineQueue({ storage, maxQueueSize: 200 });
    expect(await q.size()).toBe(2);
    const sent: string[] = [];
    await drainAndSettle(q, recordingOkSender(sent));
    expect(sent).toEqual(['persisted-1', 'persisted-2']);
  });

  it('trims persisted overflow on hydration', async () => {
    storage.items = Array.from({ length: 250 }, (_, i) => `p-${i}`);
    const q = new OfflineQueue({ storage, maxQueueSize: 200 });
    expect(await q.size()).toBe(200);
  });

  it('poking an empty queue is a no-op', async () => {
    const sender = vi.fn(async (): Promise<SendResult> => ({ status: 'ok' }));
    await drainAndSettle(queue, sender);
    expect(sender).not.toHaveBeenCalled();
  });

  it('poke without a drain sender configured is a no-op', () => {
    expect(() => queue.poke()).not.toThrow();
  });

  it('maxQueueSize of 1 keeps only the newest item', async () => {
    const q = new OfflineQueue({ storage: new MemoryStorage(), maxQueueSize: 1 });
    await q.push('a');
    await q.push('b');
    await q.push('c');
    expect(await q.size()).toBe(1);
  });

  it('counts each overflow drop toward sdk.dropped_count (ADR-028)', async () => {
    healthMonitor.reset();
    const q = new OfflineQueue({ storage: new MemoryStorage(), maxQueueSize: 2 });
    await q.push('a');
    await q.push('b');
    await q.push('c'); // drops 'a'
    await q.push('d'); // drops 'b'
    expect(await q.size()).toBe(2);
    expect(healthMonitor.getDroppedCount()).toBe(2);
  });

  it('stored payloads contain no OTel identifiers and only primitive attribute values', async () => {
    for (let i = 0; i < 3; i++) await queue.push(batchPayload(i));
    for (const raw of storage.items) {
      expect(raw).not.toMatch(/traceId/i);
      expect(raw).not.toMatch(/spanId/i);
      expect(raw).not.toMatch(/resourceSpans/i);
      expect(raw).not.toMatch(/instrumentationScope/i);
      expect(raw).not.toMatch(/opentelemetry/i);
      const parsed = JSON.parse(raw) as {
        events: { attributes: Record<string, unknown> }[];
      };
      for (const event of parsed.events) {
        for (const v of Object.values(event.attributes)) {
          expect(['string', 'number', 'boolean']).toContain(typeof v);
          expect(Array.isArray(v)).toBe(false);
        }
      }
    }
  });

  describe('drain retry lifecycle (ADR-028)', () => {
    const microflush = async (): Promise<void> => {
      for (let i = 0; i < 50; i++) await Promise.resolve();
    };

    beforeEach(() => {
      healthMonitor.reset();
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('walks [2s, 8s, 30s] then holds at 30s on repeated retryable', async () => {
      const q = new OfflineQueue({ storage: new MemoryStorage() });
      await q.push('x');
      const sender = vi.fn(async (): Promise<SendResult> => ({ status: 'retryable' }));
      q.setDrainSender(sender);

      q.poke();
      await microflush();
      expect(sender).toHaveBeenCalledTimes(1); // immediate first attempt

      await vi.advanceTimersByTimeAsync(1999);
      expect(sender).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sender).toHaveBeenCalledTimes(2); // +2s

      await vi.advanceTimersByTimeAsync(8000);
      expect(sender).toHaveBeenCalledTimes(3); // +8s

      await vi.advanceTimersByTimeAsync(30000);
      expect(sender).toHaveBeenCalledTimes(4); // +30s

      await vi.advanceTimersByTimeAsync(30000);
      expect(sender).toHaveBeenCalledTimes(5); // holds at 30s

      // Retryable never drops the item or counts toward sdk.dropped_count.
      expect(await q.size()).toBe(1);
      expect(healthMonitor.getDroppedCount()).toBe(0);
    });

    it('honors Retry-After over the step without burning a ladder rung', async () => {
      const q = new OfflineQueue({ storage: new MemoryStorage() });
      await q.push('x');
      const seq: SendResult[] = [
        { status: 'retryable', retryAfterMs: 5000 }, // overrides the wait; rung not consumed
        { status: 'retryable' }, // still step-0 → 2s
        { status: 'ok' },
      ];
      let i = 0;
      const sender = vi.fn(async (): Promise<SendResult> => seq[i++] ?? { status: 'ok' });
      q.setDrainSender(sender);

      q.poke();
      await microflush();
      expect(sender).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4999);
      expect(sender).toHaveBeenCalledTimes(1); // waiting the full 5s, not 2s
      await vi.advanceTimersByTimeAsync(1);
      expect(sender).toHaveBeenCalledTimes(2);

      // Retry-After didn't advance the ladder, so this retryable still waits 2s.
      await vi.advanceTimersByTimeAsync(2000);
      expect(sender).toHaveBeenCalledTimes(3);

      expect(await q.size()).toBe(0);
    });

    it('resets to the fast step after a success', async () => {
      const q = new OfflineQueue({ storage: new MemoryStorage() });
      await q.push('x');
      await q.push('y');
      const seq: SendResult[] = [
        { status: 'retryable' }, // x attempt 1 → wait 2s
        { status: 'ok' }, // x attempt 2 → delivered, reset; y attempted immediately
        { status: 'retryable' }, // y attempt 3 → should wait 2s again (reset), not 8s
        { status: 'ok' }, // y attempt 4
      ];
      let i = 0;
      const sender = vi.fn(async (): Promise<SendResult> => seq[i++] ?? { status: 'ok' });
      q.setDrainSender(sender);

      q.poke();
      await microflush();
      expect(sender).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2000);
      expect(sender).toHaveBeenCalledTimes(3); // x delivered, y attempted contiguously

      await vi.advanceTimersByTimeAsync(2000); // reset proven: y retries at 2s, not 8s
      expect(sender).toHaveBeenCalledTimes(4);

      expect(await q.size()).toBe(0);
    });

    it('drops a fatal batch immediately and counts it toward sdk.dropped_count', async () => {
      const q = new OfflineQueue({ storage: new MemoryStorage() });
      await q.push('bad');
      await q.push('good');
      const sent: string[] = [];
      const sender = vi.fn(async (p: string): Promise<SendResult> => {
        sent.push(p);
        return p === 'bad' ? { status: 'fatal' } : { status: 'ok' };
      });
      q.setDrainSender(sender);

      q.poke();
      await microflush();

      // 'bad' dropped without waiting, 'good' delivered right after.
      expect(sent).toEqual(['bad', 'good']);
      expect(await q.size()).toBe(0);
      expect(healthMonitor.getDroppedCount()).toBe(1);
    });

    it('advances the session sequence via onSuccess for each delivered batch', async () => {
      const q = new OfflineQueue({ storage: new MemoryStorage() });
      await q.push('a');
      await q.push('b');
      let delivered = 0;
      q.setDrainSender(async () => ({ status: 'ok' }), () => {
        delivered++;
      });

      q.poke();
      await microflush();

      expect(delivered).toBe(2);
    });

    it('clear() cancels a pending retry so a disabled SDK stops draining', async () => {
      const q = new OfflineQueue({ storage: new MemoryStorage() });
      await q.push('x');
      const sender = vi.fn(async (): Promise<SendResult> => ({ status: 'retryable' }));
      q.setDrainSender(sender);

      q.poke();
      await microflush();
      expect(sender).toHaveBeenCalledTimes(1);

      await q.clear();
      await vi.advanceTimersByTimeAsync(60000);
      expect(sender).toHaveBeenCalledTimes(1); // no further attempts after clear
    });
  });

  describe('createDefaultStorage', () => {
    it('web path uses localStorage under key edge_rum_q', async () => {
      const ls = fakeLocalStorage();
      const s = createDefaultStorage({
        capacitor: { isNativePlatform: () => false },
        localStorage: ls,
      });
      const q = new OfflineQueue({ storage: s, maxQueueSize: 10 });
      await q.push('x');
      await q.push('y');
      expect(ls.getItem(OFFLINE_QUEUE_KEY)).toBe(JSON.stringify(['x', 'y']));
    });

    it('web path hydrates from existing localStorage value', async () => {
      const ls = fakeLocalStorage();
      ls.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(['hydrated']));
      const s = createDefaultStorage({
        capacitor: { isNativePlatform: () => false },
        localStorage: ls,
      });
      const q = new OfflineQueue({ storage: s });
      expect(await q.size()).toBe(1);
    });

    it('web path removes the key when the queue empties', async () => {
      const ls = fakeLocalStorage();
      const s = createDefaultStorage({
        capacitor: { isNativePlatform: () => false },
        localStorage: ls,
      });
      const q = new OfflineQueue({ storage: s });
      await q.push('x');
      await drainAndSettle(q, async () => ({ status: 'ok' }));
      expect(ls.getItem(OFFLINE_QUEUE_KEY)).toBeNull();
    });

    it('native path uses @capacitor/preferences under key edge_rum_q', async () => {
      const prefs = fakePreferences();
      const s = createDefaultStorage({
        capacitor: { isNativePlatform: () => true },
        loadPreferences: async () => prefs,
      });
      const q = new OfflineQueue({ storage: s });
      await q.push('n1');
      await q.push('n2');
      expect(prefs.store.value).toBe(JSON.stringify(['n1', 'n2']));
    });

    it('native path hydrates from preferences value', async () => {
      const prefs = fakePreferences(JSON.stringify(['p1', 'p2']));
      const s = createDefaultStorage({
        capacitor: { isNativePlatform: () => true },
        loadPreferences: async () => prefs,
      });
      const q = new OfflineQueue({ storage: s });
      expect(await q.size()).toBe(2);
    });

    it('native path removes the key when the queue empties', async () => {
      const prefs = fakePreferences(JSON.stringify(['one']));
      const s = createDefaultStorage({
        capacitor: { isNativePlatform: () => true },
        loadPreferences: async () => prefs,
      });
      const q = new OfflineQueue({ storage: s });
      await drainAndSettle(q, async () => ({ status: 'ok' }));
      expect(prefs.store.value).toBeNull();
    });

    it('native path swallows preference-loader failures', async () => {
      const s = createDefaultStorage({
        capacitor: { isNativePlatform: () => true },
        loadPreferences: async () => {
          throw new Error('module missing');
        },
      });
      const q = new OfflineQueue({ storage: s });
      await expect(q.push('x')).resolves.toBeUndefined();
      expect(await q.size()).toBe(1);
    });

    it('falls back to a no-op store when localStorage is unavailable — nothing is persisted', async () => {
      const s = createDefaultStorage({
        capacitor: { isNativePlatform: () => false },
        localStorage: undefined,
      });
      const q1 = new OfflineQueue({ storage: s });
      await q1.push('x');
      const q2 = new OfflineQueue({ storage: s });
      expect(await q2.size()).toBe(0);
    });

    it('web path tolerates corrupt stored JSON', async () => {
      const ls = fakeLocalStorage();
      ls.setItem(OFFLINE_QUEUE_KEY, '{not json');
      const s = createDefaultStorage({
        capacitor: { isNativePlatform: () => false },
        localStorage: ls,
      });
      const q = new OfflineQueue({ storage: s });
      expect(await q.size()).toBe(0);
    });
  });
});

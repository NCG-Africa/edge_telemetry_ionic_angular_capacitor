import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OfflineQueue,
  OFFLINE_QUEUE_KEY,
  createDefaultStorage,
  type PreferencesLike,
  type QueueStorage,
} from '../src/queue/OfflineQueue';

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
    timestamp: `2024-01-15T10:30:0${i % 10}.000Z`,
    data: {
      type: 'batch',
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
    },
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

  it('failed sendFn keeps items and does not attempt subsequent items', async () => {
    await queue.push('a');
    await queue.push('b');
    await queue.push('c');

    const sent: string[] = [];
    const sendFn = vi.fn(async (payload: string) => {
      sent.push(payload);
      if (payload === 'b') throw new Error('network down');
    });

    await queue.flush(sendFn);

    expect(sent).toEqual(['a', 'b']);
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(await queue.size()).toBe(2);
    expect(storage.items).toEqual(['b', 'c']);
  });

  it('successful sendFn empties the queue completely', async () => {
    for (let i = 0; i < 5; i++) await queue.push(`p-${i}`);
    const sent: string[] = [];
    await queue.flush(async (p) => {
      sent.push(p);
    });
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
    await q.flush(async (p) => {
      sent.push(p);
    });
    expect(sent).toEqual(['persisted-1', 'persisted-2']);
  });

  it('trims persisted overflow on hydration', async () => {
    storage.items = Array.from({ length: 250 }, (_, i) => `p-${i}`);
    const q = new OfflineQueue({ storage, maxQueueSize: 200 });
    expect(await q.size()).toBe(200);
  });

  it('empty flush is a no-op', async () => {
    const sendFn = vi.fn();
    await queue.flush(sendFn);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('maxQueueSize of 1 keeps only the newest item', async () => {
    const q = new OfflineQueue({ storage: new MemoryStorage(), maxQueueSize: 1 });
    await q.push('a');
    await q.push('b');
    await q.push('c');
    expect(await q.size()).toBe(1);
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
        data: { events: { attributes: Record<string, unknown> }[] };
      };
      for (const event of parsed.data.events) {
        for (const v of Object.values(event.attributes)) {
          expect(['string', 'number', 'boolean']).toContain(typeof v);
          expect(Array.isArray(v)).toBe(false);
        }
      }
    }
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
      await q.flush(async () => {
        /* ok */
      });
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
      await q.flush(async () => {
        /* ok */
      });
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

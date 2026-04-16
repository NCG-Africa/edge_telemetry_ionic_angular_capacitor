export const OFFLINE_QUEUE_KEY = 'edge_rum_q';
export const DEFAULT_MAX_QUEUE_SIZE = 200;

export interface QueueStorage {
  load(): Promise<string[]>;
  save(items: string[]): Promise<void>;
}

export interface PreferencesLike {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

export interface CapacitorLike {
  isNativePlatform(): boolean;
}

export interface OfflineQueueOptions {
  storage?: QueueStorage;
  maxQueueSize?: number;
  capacitor?: CapacitorLike;
  loadPreferences?: () => Promise<PreferencesLike>;
  localStorage?: Storage;
  debug?: boolean;
}

export type SendFn = (payload: string) => Promise<void>;

function parseItems(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function defaultCapacitor(): CapacitorLike {
  const g = globalThis as unknown as { Capacitor?: CapacitorLike };
  if (g.Capacitor && typeof g.Capacitor.isNativePlatform === 'function') {
    return g.Capacitor;
  }
  return { isNativePlatform: () => false };
}

function defaultLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

const PREFERENCES_MODULE = '@capacitor/' + 'preferences';

function defaultLoadPreferences(): () => Promise<PreferencesLike> {
  return async () => {
    const mod = (await import(
      /* @vite-ignore */ PREFERENCES_MODULE
    )) as unknown as { Preferences: PreferencesLike };
    return mod.Preferences;
  };
}

class PreferencesStorage implements QueueStorage {
  constructor(private readonly loader: () => Promise<PreferencesLike>) {}

  async load(): Promise<string[]> {
    try {
      const prefs = await this.loader();
      const res = await prefs.get({ key: OFFLINE_QUEUE_KEY });
      return parseItems(res.value);
    } catch {
      return [];
    }
  }

  async save(items: string[]): Promise<void> {
    try {
      const prefs = await this.loader();
      if (items.length === 0) {
        await prefs.remove({ key: OFFLINE_QUEUE_KEY });
        return;
      }
      await prefs.set({ key: OFFLINE_QUEUE_KEY, value: JSON.stringify(items) });
    } catch {
      // swallow — offline queue is best-effort
    }
  }
}

class LocalStorageStorage implements QueueStorage {
  constructor(private readonly store: Storage) {}

  async load(): Promise<string[]> {
    try {
      return parseItems(this.store.getItem(OFFLINE_QUEUE_KEY));
    } catch {
      return [];
    }
  }

  async save(items: string[]): Promise<void> {
    try {
      if (items.length === 0) {
        this.store.removeItem(OFFLINE_QUEUE_KEY);
        return;
      }
      this.store.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(items));
    } catch {
      // swallow — storage may be full or disabled
    }
  }
}

class NoopStorage implements QueueStorage {
  async load(): Promise<string[]> {
    return [];
  }
  async save(): Promise<void> {
    /* no-op */
  }
}

export function createDefaultStorage(options: {
  capacitor?: CapacitorLike;
  loadPreferences?: () => Promise<PreferencesLike>;
  localStorage?: Storage;
} = {}): QueueStorage {
  const capacitor = options.capacitor ?? defaultCapacitor();
  if (capacitor.isNativePlatform()) {
    return new PreferencesStorage(options.loadPreferences ?? defaultLoadPreferences());
  }
  const ls = options.localStorage ?? defaultLocalStorage();
  if (ls) return new LocalStorageStorage(ls);
  return new NoopStorage();
}

export class OfflineQueue {
  private readonly storage: QueueStorage;
  private readonly maxQueueSize: number;
  private readonly debug: boolean;
  private items: string[] = [];
  private loaded = false;
  private loading: Promise<void> | null = null;
  private opChain: Promise<void> = Promise.resolve();

  constructor(options: OfflineQueueOptions = {}) {
    this.storage =
      options.storage ??
      createDefaultStorage({
        capacitor: options.capacitor,
        loadPreferences: options.loadPreferences,
        localStorage: options.localStorage,
      });
    this.maxQueueSize = Math.max(1, options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE);
    this.debug = options.debug ?? false;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const existing = await this.storage.load();
          this.items = existing.slice(-this.maxQueueSize);
        } catch (err) {
          if (this.debug) {
            // eslint-disable-next-line no-console
            console.warn('[edge-rum] offline queue load failed', err);
          }
          this.items = [];
        }
        this.loaded = true;
      })().catch(() => {
        this.loading = null;
      });
    }
    await this.loading;
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(op);
    this.opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  push(payload: string): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      this.items.push(payload);
      if (this.items.length > this.maxQueueSize) {
        this.items.splice(0, this.items.length - this.maxQueueSize);
      }
      await this.storage.save(this.items);
    });
  }

  flush(sendFn: SendFn): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      while (this.items.length > 0) {
        const next = this.items[0];
        if (next === undefined) break;
        try {
          await sendFn(next);
        } catch (err) {
          if (this.debug) {
            // eslint-disable-next-line no-console
            console.warn('[edge-rum] offline queue flush failed', err);
          }
          return;
        }
        this.items.shift();
        await this.storage.save(this.items);
      }
    });
  }

  size(): Promise<number> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      return this.items.length;
    });
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      this.items = [];
      await this.storage.save(this.items);
    });
  }
}

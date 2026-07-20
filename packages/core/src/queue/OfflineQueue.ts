import { healthMonitor } from '../internal/health';
import type { SendResult } from '../transport/RetryTransport';

export const OFFLINE_QUEUE_KEY = 'edge_rum_q';
export const DEFAULT_MAX_QUEUE_SIZE = 200;

// ADR-028. The retry backoff lives here (the queue owns the persisted batches
// and their retry lifecycle), not inline on the flush path. On a retryable
// result the drain walks these steps then holds at the last, honoring
// Retry-After when present, and resets to the first step on any success.
const RETRY_LADDER_MS = [2000, 8000, 30000] as const;

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

// The drain sends one persisted batch and reports how it went. onSuccess fires
// after each delivered batch (so the session sequence advances per send).
export type DrainSender = (payload: string) => Promise<SendResult>;

type DrainStep =
  | { kind: 'continue' } // ok or fatal — move to the next item with no gap
  | { kind: 'done' } // queue empty
  | { kind: 'retryable'; retryAfterMs?: number }; // keep item, back off

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

function defaultLoadPreferences(): () => Promise<PreferencesLike> {
  return async () => {
    // String-literal import path + magic comments so bundlers leave the call
    // alone:
    //   - `webpackIgnore: true` stops webpack from trying to resolve
    //     `@capacitor/preferences` at build time (it isn't installed in
    //     pure-web consumer setups). Without this, webpack emits a
    //     "Critical dependency: the request of a dependency is an expression"
    //     warning, prevents tree-shaking, and forces the consumer to
    //     `external` the package manually.
    //   - `@vite-ignore` is the equivalent for Vite-based consumers.
    //   - `rollup-disable-resolve` (no flag — Rollup defers to the runtime
    //     when the import looks dynamic).
    // The string literal itself is required so webpack can recognise the
    // `webpackIgnore` directive — the previous `'@capacitor/' + 'preferences'`
    // concat form tripped webpack's expression analyzer regardless.
    const mod = (await import(
      /* webpackIgnore: true */
      /* @vite-ignore */
      '@capacitor/preferences'
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
  private drainSender: DrainSender | null = null;
  private drainOnSuccess: (() => void) | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private backoffIndex = 0;

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
        // ADR-028. Overflow drops oldest (FIFO); count each toward the one
        // per-session sdk.dropped_count total (live-buffer + queue combined).
        const overflow = this.items.length - this.maxQueueSize;
        this.items.splice(0, overflow);
        for (let i = 0; i < overflow; i++) healthMonitor.reportDrop('offline-queue');
      }
      await this.storage.save(this.items);
    });
  }

  // Wire the transport in once at startup. The queue owns the retry lifecycle;
  // callers just push() failed batches and poke() the drain.
  setDrainSender(sender: DrainSender, onSuccess?: () => void): void {
    this.drainSender = sender;
    this.drainOnSuccess = onSuccess ?? null;
  }

  // Kick the drain. No-op if one is already running or a backoff wait is
  // pending — so a burst of pokes never stampedes into concurrent drains.
  poke(): void {
    if (this.draining || this.drainTimer !== null || !this.drainSender) return;
    void this.runDrain();
  }

  // Send items front-to-back with no artificial gap between successes. Stops
  // when the queue empties (resets backoff) or a retryable result schedules a
  // paced retry.
  private async runDrain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const step = await this.enqueue(() => this.drainOne());
        if (step.kind === 'continue') continue;
        if (step.kind === 'done') {
          this.backoffIndex = 0;
          return;
        }
        // retryable — a server Retry-After overrides this wait and does NOT burn
        // a ladder rung (the server dictates the timing); otherwise walk
        // [2s, 8s, 30s], advancing and holding at the last step. backoffIndex is
        // always clamped in-bounds, so the `?? RETRY_LADDER_MS[0]` fallback is
        // unreachable — it just satisfies noUncheckedIndexedAccess without a
        // magic number.
        let delay: number;
        if (step.retryAfterMs !== undefined) {
          delay = step.retryAfterMs;
        } else {
          delay = RETRY_LADDER_MS[this.backoffIndex] ?? RETRY_LADDER_MS[0];
          this.backoffIndex = Math.min(this.backoffIndex + 1, RETRY_LADDER_MS.length - 1);
        }
        this.drainTimer = setTimeout(() => {
          this.drainTimer = null;
          void this.runDrain();
        }, delay);
        return;
      }
    } finally {
      this.draining = false;
    }
  }

  private async drainOne(): Promise<DrainStep> {
    await this.ensureLoaded();
    const next = this.items[0];
    const sender = this.drainSender;
    if (next === undefined || !sender) return { kind: 'done' };

    let result: SendResult;
    try {
      result = await sender(next);
    } catch (err) {
      // sender contract is never-throw, but treat an unexpected throw as a
      // transient network blip rather than losing the batch.
      if (this.debug) {
        // eslint-disable-next-line no-console
        console.warn('[edge-rum] drain sender threw', err);
      }
      result = { status: 'retryable' };
    }

    if (result.status === 'retryable') {
      return { kind: 'retryable', retryAfterMs: result.retryAfterMs };
    }

    // ok or fatal both consume the item; only fatal counts as a drop.
    this.items.shift();
    await this.storage.save(this.items);
    if (result.status === 'ok') {
      this.backoffIndex = 0;
      this.drainOnSuccess?.();
    } else {
      // ADR-028. Non-retryable response — drop and count toward sdk.dropped_count.
      healthMonitor.reportDrop('transport-fatal');
    }
    return this.items.length > 0 ? { kind: 'continue' } : { kind: 'done' };
  }

  size(): Promise<number> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      return this.items.length;
    });
  }

  clear(): Promise<void> {
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.backoffIndex = 0;
    return this.enqueue(async () => {
      await this.ensureLoaded();
      this.items = [];
      await this.storage.save(this.items);
    });
  }
}

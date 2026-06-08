import type { BatchItem } from '../transport/PayloadBuilder';
import { buildBatchPayload } from '../transport/PayloadBuilder';
import type { RetryTransport } from '../transport/RetryTransport';
import type { OfflineQueue } from '../queue/OfflineQueue';
import type { SessionManager } from '../session/SessionManager';
import type { ContextManager } from './context';

export interface PipelineOptions {
  transport: RetryTransport;
  queue: OfflineQueue;
  session: SessionManager;
  context: ContextManager;
  batchSize: number;
  flushIntervalMs: number;
  location?: string;
  deferReady?: boolean;
  debug?: boolean;
}

export class Pipeline {
  private readonly transport: RetryTransport;
  private readonly queue: OfflineQueue;
  private readonly session: SessionManager;
  private readonly context: ContextManager;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private location: string | undefined;
  private readonly debug: boolean;
  private buffer: BatchItem[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private frozen = false;
  private readonly readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;

  constructor(options: PipelineOptions) {
    this.transport = options.transport;
    this.queue = options.queue;
    this.session = options.session;
    this.context = options.context;
    this.batchSize = options.batchSize;
    this.flushIntervalMs = options.flushIntervalMs;
    this.location = options.location;
    this.debug = options.debug ?? false;

    if (options.deferReady) {
      this.readyPromise = new Promise<void>((resolve) => {
        this.readyResolve = resolve;
      });
    } else {
      this.readyPromise = Promise.resolve();
    }
  }

  setLocation(location: string): void {
    if (typeof location === 'string' && location.length > 0) {
      this.location = location;
    }
  }

  markReady(): void {
    if (this.readyResolve) {
      this.readyResolve();
      this.readyResolve = null;
    }
  }

  start(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  stop(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  push(event: BatchItem): void {
    this.buffer.push(event);
    if (this.frozen) return;
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
    }
  }

  pushImmediate(event: BatchItem): void {
    this.buffer.push(event);
    if (this.frozen) return;
    void this.flush();
  }

  freeze(): void {
    this.frozen = true;
  }

  unfreeze(): void {
    this.frozen = false;
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    await this.readyPromise;
    this.flushing = true;

    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.splice(0, this.batchSize);
        this.backfillStableContext(batch);
        const payload = buildBatchPayload(batch, this.location);
        const body = JSON.stringify(payload);

        try {
          await this.transport.send(body);
          this.session.incrementSequence();
          // Opportunistically drain the offline queue after every successful
          // live send — turns transient outages into self-healing without
          // requiring an explicit foreground/network-reconnect trigger.
          void this.flushOfflineQueue();
        } catch (err) {
          if (this.debug) {
            // eslint-disable-next-line no-console
            console.warn('[edge-rum] send failed, queuing offline', err);
          }
          await this.queue.push(body);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async flushOfflineQueue(): Promise<void> {
    await this.queue.flush(async (body: string) => {
      await this.transport.send(body);
      this.session.incrementSequence();
    });
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  buildBeaconPayload(): { url: string; body: string; headers: Record<string, string> } | null {
    if (this.buffer.length === 0) return null;
    const batch = this.buffer.splice(0, this.buffer.length);
    this.backfillStableContext(batch);
    const payload = buildBatchPayload(batch, this.location);
    return {
      url: this.transport.getEndpoint(),
      body: JSON.stringify(payload),
      headers: {
        'X-API-Key': this.transport.getApiKey(),
        'Content-Type': 'application/json',
      },
    };
  }

  // Events recorded before device context loaded have no device.id; events
  // recorded before the native app build resolves have no app.build_number.
  // Stable context (app.*, device.*, sdk.*) doesn't change for the session
  // lifetime, so back-filling at flush time is safe and gives every event
  // the full context the backend expects. Volatile attrs (session.*, user.*,
  // network.*) stay captured-at-record-time.
  private backfillStableContext(batch: BatchItem[]): void {
    let stable: ReturnType<ContextManager['getStableContextAttributes']> | null = null;
    for (const item of batch) {
      const needsBackfill =
        typeof item.attributes['device.id'] !== 'string' ||
        typeof item.attributes['app.build_number'] !== 'string';
      if (needsBackfill) {
        if (stable === null) stable = this.context.getStableContextAttributes();
        item.attributes = { ...stable, ...item.attributes };
      }
    }
  }
}

import type { EventPayload } from '../transport/PayloadBuilder';
import { buildBatchPayload } from '../transport/PayloadBuilder';
import type { RetryTransport } from '../transport/RetryTransport';
import type { OfflineQueue } from '../queue/OfflineQueue';
import type { SessionManager } from '../session/SessionManager';

export interface PipelineOptions {
  transport: RetryTransport;
  queue: OfflineQueue;
  session: SessionManager;
  batchSize: number;
  flushIntervalMs: number;
  debug?: boolean;
}

export class Pipeline {
  private readonly transport: RetryTransport;
  private readonly queue: OfflineQueue;
  private readonly session: SessionManager;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly debug: boolean;
  private buffer: EventPayload[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(options: PipelineOptions) {
    this.transport = options.transport;
    this.queue = options.queue;
    this.session = options.session;
    this.batchSize = options.batchSize;
    this.flushIntervalMs = options.flushIntervalMs;
    this.debug = options.debug ?? false;
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

  push(event: EventPayload): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
    }
  }

  pushImmediate(event: EventPayload): void {
    this.buffer.push(event);
    void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;

    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.splice(0, this.batchSize);
        const payload = buildBatchPayload(batch);
        const body = JSON.stringify(payload);

        try {
          await this.transport.send(body);
          this.session.incrementSequence();
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
}

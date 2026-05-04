import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Pipeline } from '../src/internal/pipeline';
import { buildEventPayload } from '../src/transport/PayloadBuilder';
import { SessionManager } from '../src/session/SessionManager';
import type { RetryTransport } from '../src/transport/RetryTransport';
import type { OfflineQueue } from '../src/queue/OfflineQueue';

function createMockTransport(): RetryTransport {
  return { send: vi.fn().mockResolvedValue(undefined) } as unknown as RetryTransport;
}

function createMockQueue(): OfflineQueue & { push: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> } {
  return {
    push: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    size: vi.fn().mockResolvedValue(0),
  } as unknown as OfflineQueue & { push: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> };
}

describe('Pipeline', () => {
  let transport: RetryTransport & { send: ReturnType<typeof vi.fn> };
  let queue: ReturnType<typeof createMockQueue>;
  let session: SessionManager;
  let pipeline: Pipeline;

  beforeEach(() => {
    transport = createMockTransport() as RetryTransport & { send: ReturnType<typeof vi.fn> };
    queue = createMockQueue();
    session = new SessionManager();
    pipeline = new Pipeline({
      transport,
      queue,
      session,
      batchSize: 3,
      flushIntervalMs: 60000,
      debug: false,
    });
  });

  it('accumulates events in the buffer', () => {
    const event = buildEventPayload('test', {}, {});
    pipeline.push(event);
    expect(pipeline.getBufferSize()).toBe(1);
  });

  it('flushes when batch size is reached', async () => {
    for (let i = 0; i < 3; i++) {
      pipeline.push(buildEventPayload('test', {}, { i }));
    }
    // wait for async flush
    await new Promise((r) => setTimeout(r, 10));
    expect(transport.send).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(transport.send.mock.calls[0]?.[0]));
    expect(body.type).toBe('batch');
    expect(body.events).toHaveLength(3);
  });

  it('increments session sequence on successful send', async () => {
    pipeline.push(buildEventPayload('test', {}, {}));
    await pipeline.flush();
    expect(session.getSequence()).toBe(1);
  });

  it('pushes to offline queue on transport failure', async () => {
    transport.send.mockRejectedValueOnce(new Error('network'));
    pipeline.push(buildEventPayload('test', {}, {}));
    await pipeline.flush();
    expect(queue.push).toHaveBeenCalledTimes(1);
  });

  it('pushImmediate triggers immediate flush', async () => {
    pipeline.pushImmediate(buildEventPayload('app.crash', {}, {}));
    await new Promise((r) => setTimeout(r, 10));
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it('sends JSON with the correct envelope', async () => {
    pipeline.push(buildEventPayload('screen_view', { 'sdk.platform': 'ionic-angular-capacitor', 'device.id': 'device_1_abcd1234_web' }, {}));
    await pipeline.flush();
    const body = JSON.parse(String(transport.send.mock.calls[0]?.[0]));
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.type).toBe('batch');
    body.events.forEach((ev: Record<string, unknown>) => {
      expect(ev.type).toBe('event');
      const attrs = ev.attributes as Record<string, unknown>;
      Object.values(attrs).forEach((v) => {
        expect(typeof v).toMatch(/^(string|number|boolean)$/);
      });
    });
    expect(JSON.stringify(body)).not.toContain('traceId');
    expect(JSON.stringify(body)).not.toContain('spanId');
    expect(JSON.stringify(body)).not.toContain('opentelemetry');
  });

  it('flushOfflineQueue delegates to queue.flush', async () => {
    await pipeline.flushOfflineQueue();
    expect(queue.flush).toHaveBeenCalledTimes(1);
  });

  describe('deferReady', () => {
    let deferredPipeline: Pipeline;

    beforeEach(() => {
      deferredPipeline = new Pipeline({
        transport,
        queue,
        session,
        batchSize: 3,
        flushIntervalMs: 60000,
        deferReady: true,
        debug: false,
      });
    });

    it('does not flush until markReady is called', async () => {
      deferredPipeline.push(buildEventPayload('test', {}, {}));
      // Start flush but don't await — it blocks on readyPromise
      void deferredPipeline.flush();
      await new Promise((r) => setTimeout(r, 50));
      expect(transport.send).not.toHaveBeenCalled();
      // Now unblock
      deferredPipeline.markReady();
      await new Promise((r) => setTimeout(r, 50));
      expect(transport.send).toHaveBeenCalledTimes(1);
    });

    it('flushes buffered events after markReady', async () => {
      deferredPipeline.push(buildEventPayload('test', { 'device.id': 'device_1_abcd1234_web' }, {}));
      deferredPipeline.markReady();
      await deferredPipeline.flush();
      expect(transport.send).toHaveBeenCalledTimes(1);
    });

    it('default pipeline (no deferReady) flushes immediately', async () => {
      // uses the non-deferred pipeline from the outer beforeEach
      pipeline.push(buildEventPayload('test', {}, {}));
      await pipeline.flush();
      expect(transport.send).toHaveBeenCalledTimes(1);
    });
  });
});

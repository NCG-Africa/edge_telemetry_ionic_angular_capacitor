import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Pipeline } from '../src/internal/pipeline';
import { ContextManager } from '../src/internal/context';
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
  let context: ContextManager;
  let pipeline: Pipeline;

  beforeEach(() => {
    transport = createMockTransport() as RetryTransport & { send: ReturnType<typeof vi.fn> };
    queue = createMockQueue();
    session = new SessionManager();
    context = new ContextManager(session);
    pipeline = new Pipeline({
      transport,
      queue,
      session,
      context,
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
    expect(body.type).toBe('telemetry_batch');
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
    pipeline.push(buildEventPayload('navigation', { 'sdk.platform': 'ionic-angular-capacitor', 'device.id': 'device_1_abcd1234_web' }, {}));
    await pipeline.flush();
    const body = JSON.parse(String(transport.send.mock.calls[0]?.[0]));
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.type).toBe('telemetry_batch');
    expect(body).not.toHaveProperty('device_id');
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

  it('includes location in the envelope when set on the pipeline', async () => {
    const locatedPipeline = new Pipeline({
      transport,
      queue,
      session,
      context,
      batchSize: 3,
      flushIntervalMs: 60000,
      location: 'Nairobi/Kenya',
    });
    locatedPipeline.push(buildEventPayload('navigation', { 'device.id': 'device_1_abcd1234_web' }, {}));
    await locatedPipeline.flush();
    const body = JSON.parse(String(transport.send.mock.calls[0]?.[0]));
    expect(body.location).toBe('Nairobi/Kenya');
  });

  it('flushOfflineQueue delegates to queue.flush', async () => {
    await pipeline.flushOfflineQueue();
    expect(queue.flush).toHaveBeenCalledTimes(1);
  });

  describe('stable-context back-fill', () => {
    it('back-fills app.* and device.* on items that lack device.id at flush time', async () => {
      // Simulate: event recorded BEFORE device context loaded.
      // (Collector captures empty device attrs; later setDeviceAttributes resolves them.)
      pipeline.push(buildEventPayload('navigation', {}, { 'navigation.to_screen': '/home' }));

      // Now the bootstrap completes and device context is set.
      context.setAppAttributes({
        apiKey: 'edge_x',
        endpoint: 'https://example.com/collector/telemetry',
        appName: 'MyApp',
      });
      context.setDeviceAttributes({
        'device.id': 'device_1_abcd1234_web',
        'device.platform': 'web',
        'device.platform_version': '17.4',
      });

      await pipeline.flush();

      const body = JSON.parse(String(transport.send.mock.calls[0]?.[0]));
      const navEvent = body.events[0];
      expect(navEvent.attributes['device.id']).toBe('device_1_abcd1234_web');
      expect(navEvent.attributes['device.platform']).toBe('web');
      expect(navEvent.attributes['device.platform_version']).toBe('17.4');
      expect(navEvent.attributes['app.name']).toBe('MyApp');
      expect(navEvent.attributes['sdk.platform']).toBe('ionic-angular-capacitor');
      // event-specific attribute survives
      expect(navEvent.attributes['navigation.to_screen']).toBe('/home');
    });

    it('does not back-fill items that already have device.id (preserves captured-at-record-time context)', async () => {
      // Event recorded AFTER bootstrap with the original device.id.
      pipeline.push(
        buildEventPayload('performance', { 'device.id': 'device_OLD_web', 'app.name': 'OldApp' }, { 'performance.metric_name': 'LCP' }),
      );

      // Hypothetically, context changes after recording (e.g. config rebuild).
      context.setAppAttributes({
        apiKey: 'edge_x',
        endpoint: 'https://example.com/collector/telemetry',
        appName: 'NewApp',
      });
      context.setDeviceAttributes({ 'device.id': 'device_NEW_web' });

      await pipeline.flush();

      const body = JSON.parse(String(transport.send.mock.calls[0]?.[0]));
      const perfEvent = body.events[0];
      expect(perfEvent.attributes['device.id']).toBe('device_OLD_web');
      expect(perfEvent.attributes['app.name']).toBe('OldApp');
    });
  });

  describe('deferReady', () => {
    let deferredPipeline: Pipeline;

    beforeEach(() => {
      deferredPipeline = new Pipeline({
        transport,
        queue,
        session,
        context,
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

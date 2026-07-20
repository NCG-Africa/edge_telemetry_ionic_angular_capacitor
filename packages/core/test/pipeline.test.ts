import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Pipeline } from '../src/internal/pipeline';
import { ContextManager } from '../src/internal/context';
import { buildEventPayload } from '../src/transport/PayloadBuilder';
import { SessionManager } from '../src/session/SessionManager';
import { healthMonitor } from '../src/internal/health';
import type { RetryTransport } from '../src/transport/RetryTransport';
import type { OfflineQueue } from '../src/queue/OfflineQueue';

function createMockTransport(opts: { endpoint?: string; apiKey?: string } = {}): RetryTransport {
  return {
    sendOnce: vi.fn().mockResolvedValue({ status: 'ok' }),
    getEndpoint: () => opts.endpoint ?? 'https://example.com/collector/telemetry',
    getApiKey: () => opts.apiKey ?? 'edge_test_key',
  } as unknown as RetryTransport;
}

function createMockQueue(): OfflineQueue & { push: ReturnType<typeof vi.fn>; poke: ReturnType<typeof vi.fn> } {
  return {
    push: vi.fn().mockResolvedValue(undefined),
    poke: vi.fn(),
    setDrainSender: vi.fn(),
    clear: vi.fn().mockResolvedValue(undefined),
    size: vi.fn().mockResolvedValue(0),
  } as unknown as OfflineQueue & { push: ReturnType<typeof vi.fn>; poke: ReturnType<typeof vi.fn> };
}

describe('Pipeline', () => {
  let transport: RetryTransport & { sendOnce: ReturnType<typeof vi.fn> };
  let queue: ReturnType<typeof createMockQueue>;
  let session: SessionManager;
  let context: ContextManager;
  let pipeline: Pipeline;

  beforeEach(() => {
    transport = createMockTransport() as RetryTransport & { sendOnce: ReturnType<typeof vi.fn> };
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
    expect(transport.sendOnce).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(transport.sendOnce.mock.calls[0]?.[0]));
    expect(body.type).toBe('telemetry_batch');
    expect(body.events).toHaveLength(3);
  });

  it('increments session sequence on successful send', async () => {
    pipeline.push(buildEventPayload('test', {}, {}));
    await pipeline.flush();
    expect(session.getSequence()).toBe(1);
  });

  it('pushes to offline queue on a non-ok (retryable) send', async () => {
    transport.sendOnce.mockResolvedValueOnce({ status: 'retryable' });
    pipeline.push(buildEventPayload('test', {}, {}));
    await pipeline.flush();
    expect(queue.push).toHaveBeenCalledTimes(1);
    expect(queue.poke).toHaveBeenCalled();
  });

  it('does not increment the session sequence on a non-ok send', async () => {
    transport.sendOnce.mockResolvedValueOnce({ status: 'retryable' });
    pipeline.push(buildEventPayload('test', {}, {}));
    await pipeline.flush();
    expect(session.getSequence()).toBe(0);
  });

  it('pushImmediate triggers immediate flush', async () => {
    pipeline.pushImmediate(buildEventPayload('app.crash', {}, {}));
    await new Promise((r) => setTimeout(r, 10));
    expect(transport.sendOnce).toHaveBeenCalledTimes(1);
  });

  it('sends JSON with the correct envelope', async () => {
    pipeline.push(buildEventPayload('navigation', { 'sdk.platform': 'ionic-angular-capacitor', 'device.id': 'device_1_abcd1234_web' }, {}));
    await pipeline.flush();
    const body = JSON.parse(String(transport.sendOnce.mock.calls[0]?.[0]));
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
    const body = JSON.parse(String(transport.sendOnce.mock.calls[0]?.[0]));
    expect(body.location).toBe('Nairobi/Kenya');
  });

  it('flushOfflineQueue pokes the queue drain', async () => {
    await pipeline.flushOfflineQueue();
    expect(queue.poke).toHaveBeenCalledTimes(1);
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

      const body = JSON.parse(String(transport.sendOnce.mock.calls[0]?.[0]));
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
        buildEventPayload(
          'navigation',
          {
            'device.id': 'device_OLD_web',
            'app.name': 'OldApp',
            'app.build_number': '41',
          },
          { 'navigation.to_screen': '/home' },
        ),
      );

      // Hypothetically, context changes after recording (e.g. config rebuild).
      context.setAppAttributes({
        apiKey: 'edge_x',
        endpoint: 'https://example.com/collector/telemetry',
        appName: 'NewApp',
        appBuild: '99',
      });
      context.setDeviceAttributes({ 'device.id': 'device_NEW_web' });

      await pipeline.flush();

      const body = JSON.parse(String(transport.sendOnce.mock.calls[0]?.[0]));
      const ev = body.events[0];
      expect(ev.attributes['device.id']).toBe('device_OLD_web');
      expect(ev.attributes['app.name']).toBe('OldApp');
      expect(ev.attributes['app.build_number']).toBe('41');
    });

    it('back-fills app.build_number on events recorded before the native build resolved', async () => {
      // Event recorded with device.id but no app.build_number (native build still loading).
      context.setAppAttributes({
        apiKey: 'edge_x',
        endpoint: 'https://example.com/collector/telemetry',
        appName: 'MyApp',
      });
      pipeline.push(
        buildEventPayload(
          'navigation',
          { 'device.id': 'device_1_abcd1234_web', 'app.name': 'MyApp' },
          { 'navigation.to_screen': '/home' },
        ),
      );

      // Native bootstrap completes and resolves app.build_number.
      context.setAppBuildNumber('42');

      await pipeline.flush();

      const body = JSON.parse(String(transport.sendOnce.mock.calls[0]?.[0]));
      const ev = body.events[0];
      expect(ev.attributes['app.build_number']).toBe('42');
      expect(ev.attributes['navigation.to_screen']).toBe('/home');
    });

    it('never emits an empty-string app.build_number when the build is unknown at flush time', async () => {
      // No appBuild, no setAppBuildNumber call — build is genuinely unknown.
      context.setAppAttributes({
        apiKey: 'edge_x',
        endpoint: 'https://example.com/collector/telemetry',
      });
      pipeline.push(
        buildEventPayload(
          'navigation',
          { 'device.id': 'device_1_abcd1234_web' },
          { 'navigation.to_screen': '/home' },
        ),
      );

      await pipeline.flush();

      const body = JSON.parse(String(transport.sendOnce.mock.calls[0]?.[0]));
      const ev = body.events[0];
      // Field is absent rather than "".
      expect(ev.attributes['app.build_number']).toBeUndefined();
    });

    it('keeps app.build_number consistent across a batch (no mixing of "" and real value)', async () => {
      // First event before build resolves.
      context.setAppAttributes({
        apiKey: 'edge_x',
        endpoint: 'https://example.com/collector/telemetry',
      });
      pipeline.push(
        buildEventPayload(
          'navigation',
          { 'device.id': 'device_1_abcd1234_web' },
          { 'navigation.to_screen': '/a' },
        ),
      );
      // Build resolves.
      context.setAppBuildNumber('42');
      // Second event after build resolves carries it at record time.
      pipeline.push(
        buildEventPayload(
          'navigation',
          {
            'device.id': 'device_1_abcd1234_web',
            'app.build_number': '42',
          },
          { 'navigation.to_screen': '/b' },
        ),
      );

      await pipeline.flush();

      const body = JSON.parse(String(transport.sendOnce.mock.calls[0]?.[0]));
      const builds = body.events.map((e: { attributes: Record<string, string> }) => e.attributes['app.build_number']);
      expect(new Set(builds)).toEqual(new Set(['42']));
      builds.forEach((b: string) => expect(b).not.toBe(''));
    });
  });

  describe('buildBeaconPayload', () => {
    it('returns null when buffer is empty', () => {
      expect(pipeline.buildBeaconPayload()).toBeNull();
    });

    it('drains the buffer and produces a JSON body with telemetry_batch envelope', () => {
      pipeline.push(buildEventPayload('session.finalized', { 'device.id': 'device_1_abcd1234abcd1234_web' }, { 'session.end_reason': 'app_closed' }));
      pipeline.push(buildEventPayload('custom_event', { 'device.id': 'device_1_abcd1234abcd1234_web' }, { 'event.name': 'x' }));

      const beacon = pipeline.buildBeaconPayload();
      expect(beacon).not.toBeNull();
      expect(beacon!.url).toBe('https://example.com/collector/telemetry');
      expect(beacon!.headers['X-API-Key']).toBe('edge_test_key');
      expect(beacon!.headers['Content-Type']).toBe('application/json');
      const parsed = JSON.parse(beacon!.body);
      expect(parsed.type).toBe('telemetry_batch');
      expect(parsed.events).toHaveLength(2);
      // Buffer is now empty
      expect(pipeline.getBufferSize()).toBe(0);
    });
  });

  describe('freeze / unfreeze', () => {
    it('frozen pipeline does not auto-flush on pushImmediate', async () => {
      pipeline.freeze();
      pipeline.pushImmediate(buildEventPayload('app.crash', {}, {}));
      await new Promise((r) => setTimeout(r, 20));
      expect(transport.sendOnce).not.toHaveBeenCalled();
      expect(pipeline.getBufferSize()).toBe(1);
    });

    it('frozen pipeline does not auto-flush on push when batch is reached', async () => {
      pipeline.freeze();
      for (let i = 0; i < 5; i++) {
        pipeline.push(buildEventPayload('custom_event', {}, { i }));
      }
      await new Promise((r) => setTimeout(r, 20));
      expect(transport.sendOnce).not.toHaveBeenCalled();
      expect(pipeline.getBufferSize()).toBe(5);
    });

    it('unfreeze re-enables auto-flush on next push', async () => {
      pipeline.freeze();
      pipeline.pushImmediate(buildEventPayload('app.crash', {}, {}));
      pipeline.unfreeze();
      // need a fresh push to trigger flush
      pipeline.pushImmediate(buildEventPayload('app.crash', {}, {}));
      await new Promise((r) => setTimeout(r, 20));
      expect(transport.sendOnce).toHaveBeenCalledTimes(1);
    });

    it('explicit flush() still works while frozen', async () => {
      pipeline.freeze();
      pipeline.push(buildEventPayload('custom_event', {}, {}));
      await pipeline.flush();
      expect(transport.sendOnce).toHaveBeenCalledTimes(1);
    });
  });

  describe('post-flush offline queue drain', () => {
    it('pokes the offline queue drain after every successful send', async () => {
      pipeline.push(buildEventPayload('custom_event', {}, {}));
      await pipeline.flush();
      expect(queue.poke).toHaveBeenCalled();
    });
  });

  describe('bounded buffer (ADR-028)', () => {
    // batchSize is 3 → cap = batchSize × 10 = 30.
    beforeEach(() => {
      healthMonitor.reset();
      pipeline.freeze(); // stop auto-flush so the buffer can fill past the cap
    });

    it('never exceeds batchSize × 10 and drops the oldest on overflow', () => {
      for (let i = 0; i < 35; i++) {
        pipeline.push(buildEventPayload('custom_event', {}, { i }));
      }
      expect(pipeline.getBufferSize()).toBe(30);
      // 5 dropped (35 pushed − 30 cap)
      expect(healthMonitor.getDroppedCount()).toBe(5);
    });

    it('drops the oldest events (FIFO), keeping the freshest', async () => {
      for (let i = 0; i < 35; i++) {
        pipeline.push(buildEventPayload('custom_event', {}, { i }));
      }
      pipeline.unfreeze();
      await pipeline.flush();
      const bodies = transport.sendOnce.mock.calls.map((c) => JSON.parse(String(c[0])));
      const seen = bodies.flatMap((b) => b.events.map((e: { attributes: { i: number } }) => e.attributes.i));
      // Oldest 5 (i=0..4) were dropped; freshest survive.
      expect(seen).not.toContain(0);
      expect(seen).not.toContain(4);
      expect(seen).toContain(5);
      expect(seen).toContain(34);
    });

    it('never drops a pushImmediate (crash/error) event to satisfy the cap', async () => {
      // A crash queued first, then the buffer floods past the cap.
      pipeline.pushImmediate(buildEventPayload('app.crash', {}, { crash: true }));
      for (let i = 0; i < 60; i++) {
        pipeline.push(buildEventPayload('custom_event', {}, { i }));
      }
      expect(pipeline.getBufferSize()).toBe(30);
      pipeline.unfreeze();
      await pipeline.flush();
      const seen = transport.sendOnce.mock.calls
        .map((c) => JSON.parse(String(c[0])))
        .flatMap((b) => b.events);
      expect(seen.some((e: { eventName?: string }) => e.eventName === 'app.crash')).toBe(true);
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
      expect(transport.sendOnce).not.toHaveBeenCalled();
      // Now unblock
      deferredPipeline.markReady();
      await new Promise((r) => setTimeout(r, 50));
      expect(transport.sendOnce).toHaveBeenCalledTimes(1);
    });

    it('flushes buffered events after markReady', async () => {
      deferredPipeline.push(buildEventPayload('test', { 'device.id': 'device_1_abcd1234_web' }, {}));
      deferredPipeline.markReady();
      await deferredPipeline.flush();
      expect(transport.sendOnce).toHaveBeenCalledTimes(1);
    });

    it('default pipeline (no deferReady) flushes immediately', async () => {
      // uses the non-deferred pipeline from the outer beforeEach
      pipeline.push(buildEventPayload('test', {}, {}));
      await pipeline.flush();
      expect(transport.sendOnce).toHaveBeenCalledTimes(1);
    });
  });
});

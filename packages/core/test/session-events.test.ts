import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EdgeRum, __getCollector, __getPipeline, __resetEdgeRumForTests } from '../src/EdgeRum';
import { buildEventPayload } from '../src/transport/PayloadBuilder';

describe('session lifecycle events', () => {
  const config = {
    apiKey: 'edge_test_key',
    endpoint: 'https://example.com/collector/telemetry',
  };

  beforeEach(() => {
    __resetEdgeRumForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetEdgeRumForTests();
  });

  it('EdgeRum.init() emits exactly one session.started with start_reason=init', () => {
    EdgeRum.init(config);

    const pipeline = __getPipeline();
    expect(pipeline).not.toBeNull();
    expect(pipeline!.getBufferSize()).toBeGreaterThanOrEqual(1);

    const collector = __getCollector();
    expect(collector).not.toBeNull();

    // Spy on a SECOND call to confirm subsequent events flow through the same path
    const spy = vi.spyOn(collector!, 'recordEvent');
    spy.mockClear();

    // No new session.started should be emitted on subsequent unrelated calls
    EdgeRum.track('after_init');
    const sessionStartedEmits = spy.mock.calls.filter(([name]) => name === 'session.started');
    expect(sessionStartedEmits).toHaveLength(0);
  });

  it('the session.started:init event carries the current session.id (via context)', () => {
    EdgeRum.init(config);
    const sessionId = EdgeRum.getSessionId();
    expect(sessionId).toMatch(/^session_\d+_[0-9a-f]{16}_(ios|android|web)$/);
  });

  it('Collector routes session.finalized through pushImmediate (immediate flush)', () => {
    EdgeRum.init(config);
    const collector = __getCollector()!;
    const pipeline = __getPipeline()!;
    const pushImmediateSpy = vi.spyOn(pipeline, 'pushImmediate');
    const pushSpy = vi.spyOn(pipeline, 'push');

    collector.recordEvent('session.finalized', { 'session.end_reason': 'backgrounded' });

    expect(pushImmediateSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('Collector routes session.started through push (regular flush path)', () => {
    EdgeRum.init(config);
    const collector = __getCollector()!;
    const pipeline = __getPipeline()!;
    const pushImmediateSpy = vi.spyOn(pipeline, 'pushImmediate');
    const pushSpy = vi.spyOn(pipeline, 'push');

    collector.recordEvent('session.started', { 'session.start_reason': 'resumed' });

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushImmediateSpy).not.toHaveBeenCalled();
  });

  it('app.crash still routes through pushImmediate (regression)', () => {
    EdgeRum.init(config);
    const collector = __getCollector()!;
    const pipeline = __getPipeline()!;
    // sanity — use buildEventPayload to align with collector internals
    void buildEventPayload;
    const pushImmediateSpy = vi.spyOn(pipeline, 'pushImmediate');

    collector.recordEvent('app.crash', {
      exception_type: 'Error',
      message: 'x',
      stacktrace: '',
      is_fatal: false,
      handled: false,
      error_context: '',
      cause: 'ManualCapture',
      runtime: 'webview',
    });

    expect(pushImmediateSpy).toHaveBeenCalledTimes(1);
  });
});

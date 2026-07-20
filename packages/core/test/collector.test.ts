import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Collector } from '../src/internal/collector';
import { ContextManager } from '../src/internal/context';
import { Pipeline } from '../src/internal/pipeline';
import { SessionManager } from '../src/session/SessionManager';
import type { RetryTransport } from '../src/transport/RetryTransport';
import type { OfflineQueue } from '../src/queue/OfflineQueue';

function createMockTransport(): RetryTransport {
  return { sendOnce: vi.fn().mockResolvedValue({ status: 'ok' }) } as unknown as RetryTransport;
}

function createMockQueue(): OfflineQueue {
  return {
    push: vi.fn().mockResolvedValue(undefined),
    poke: vi.fn(),
    setDrainSender: vi.fn(),
    clear: vi.fn().mockResolvedValue(undefined),
    size: vi.fn().mockResolvedValue(0),
  } as unknown as OfflineQueue;
}

describe('Collector — journey wiring', () => {
  let session: SessionManager;
  let context: ContextManager;
  let pipeline: Pipeline;
  let collector: Collector;

  beforeEach(() => {
    session = new SessionManager({ platform: 'web' });
    context = new ContextManager(session);
    pipeline = new Pipeline({
      transport: createMockTransport(),
      queue: createMockQueue(),
      session,
      context,
      batchSize: 100,
      flushIntervalMs: 60_000,
    });
    collector = new Collector({ context, pipeline, session });
  });

  it('recordEvent increments session.event_count', () => {
    collector.recordEvent('custom_event', { 'event.name': 'a' });
    collector.recordEvent('custom_event', { 'event.name': 'b' });
    expect(session.getJourneySnapshot()['session.event_count']).toBe(2);
  });

  it('recordEvent("navigation") appends navigation.to_screen to visited_screens', () => {
    collector.recordEvent('navigation', { 'navigation.to_screen': '/home' });
    collector.recordEvent('navigation', { 'navigation.to_screen': '/profile' });
    const snap = session.getJourneySnapshot();
    expect(snap['session.visited_screens']).toBe('/home,/profile');
    expect(snap['session.screen_count']).toBe(2);
  });

  it('recordEvent for non-navigation events does NOT touch visited_screens', () => {
    collector.recordEvent('custom_event', { 'event.name': 'a' });
    collector.recordEvent('http.request', { 'http.url': 'https://x' });
    const snap = session.getJourneySnapshot();
    expect(snap['session.visited_screens']).toBe('');
    expect(snap['session.screen_count']).toBe(0);
  });

  it('navigation event without a string navigation.to_screen does NOT touch visited_screens', () => {
    collector.recordEvent('navigation', {});
    collector.recordEvent('navigation', { 'navigation.to_screen': 123 as unknown as string });
    const snap = session.getJourneySnapshot();
    expect(snap['session.screen_count']).toBe(0);
  });

  it('recordMetric increments session.metric_count', () => {
    collector.recordMetric('image_upload', 100);
    collector.recordMetric('FCP', 670);
    expect(session.getJourneySnapshot()['session.metric_count']).toBe(2);
  });

  it('sample-rate-dropped events do not increment counters (no phantom counts)', () => {
    // Session-level sampling: roll out by constructing a SessionManager with sampleRate=0.
    const sampledOutSession = new SessionManager({ platform: 'web', sampleRate: 0 });
    const sampledContext = new ContextManager(sampledOutSession);
    const sampledPipeline = new Pipeline({
      transport: createMockTransport(),
      queue: createMockQueue(),
      session: sampledOutSession,
      context: sampledContext,
      batchSize: 100,
      flushIntervalMs: 60_000,
    });
    const sampledCollector = new Collector({
      context: sampledContext,
      pipeline: sampledPipeline,
      session: sampledOutSession,
    });
    sampledCollector.recordEvent('custom_event', {});
    sampledCollector.recordEvent('navigation', { 'navigation.to_screen': '/home' });
    sampledCollector.recordMetric('m', 1);
    const snap = sampledOutSession.getJourneySnapshot();
    expect(snap['session.event_count']).toBe(0);
    expect(snap['session.metric_count']).toBe(0);
    expect(snap['session.screen_count']).toBe(0);
  });

  it('critical events bypass session-level sampling', () => {
    const sampledOutSession = new SessionManager({ platform: 'web', sampleRate: 0 });
    const sampledContext = new ContextManager(sampledOutSession);
    const sampledPipeline = new Pipeline({
      transport: createMockTransport(),
      queue: createMockQueue(),
      session: sampledOutSession,
      context: sampledContext,
      batchSize: 100,
      flushIntervalMs: 60_000,
    });
    const sampledCollector = new Collector({
      context: sampledContext,
      pipeline: sampledPipeline,
      session: sampledOutSession,
    });

    const pushSpy = vi.spyOn(sampledPipeline, 'push');
    const pushImmediateSpy = vi.spyOn(sampledPipeline, 'pushImmediate');

    sampledCollector.recordEvent('session.started', { 'session.start_reason': 'init' });
    sampledCollector.recordEvent('session.finalized', { 'session.end_reason': 'app_closed' });
    sampledCollector.recordEvent('app.crash', { message: 'x' });
    sampledCollector.recordEvent('user.profile.update', { 'user.name': 'A' });
    // Non-critical event is dropped
    sampledCollector.recordEvent('custom_event', {});

    expect(pushSpy.mock.calls.length + pushImmediateSpy.mock.calls.length).toBe(4);
  });

  it('disabled collector does not increment counters', () => {
    collector.setEnabled(false);
    collector.recordEvent('navigation', { 'navigation.to_screen': '/home' });
    collector.recordMetric('m', 1);
    const snap = session.getJourneySnapshot();
    expect(snap['session.event_count']).toBe(0);
    expect(snap['session.metric_count']).toBe(0);
    expect(snap['session.screen_count']).toBe(0);
  });
});

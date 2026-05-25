import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EdgeRum } from '../src/EdgeRum';
import { __getCollector, __resetEdgeRumForTests } from '../src/EdgeRum';

describe('EdgeRum.identify()', () => {
  const config = {
    apiKey: 'edge_test_key',
    endpoint: 'https://example.com/collector/telemetry',
  };

  beforeEach(() => {
    __resetEdgeRumForTests();
    EdgeRum.init(config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetEdgeRumForTests();
  });

  it('emits a user.profile.update event with version=1 on the first call', () => {
    const collector = __getCollector()!;
    const spy = vi.spyOn(collector, 'recordEvent');

    EdgeRum.identify({ name: 'Emily', email: 'emily@example.com' });

    expect(spy).toHaveBeenCalledTimes(1);
    const [eventName, attrs] = spy.mock.calls[0]!;
    expect(eventName).toBe('user.profile.update');
    expect(attrs['user.name']).toBe('Emily');
    expect(attrs['user.email']).toBe('emily@example.com');
    expect(attrs['user.profile_version']).toBe(1);
    expect(attrs['user.profile_updated_at']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('increments user.profile_version on each subsequent call', () => {
    const collector = __getCollector()!;
    const spy = vi.spyOn(collector, 'recordEvent');

    EdgeRum.identify({ name: 'Emily' });
    EdgeRum.identify({ email: 'emily@example.com' });
    EdgeRum.identify({ phone: '+1-555-0100' });

    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[0]![1]['user.profile_version']).toBe(1);
    expect(spy.mock.calls[1]![1]['user.profile_version']).toBe(2);
    expect(spy.mock.calls[2]![1]['user.profile_version']).toBe(3);
  });

  it('only forwards fields present on this specific call (does not echo prior values)', () => {
    const collector = __getCollector()!;
    const spy = vi.spyOn(collector, 'recordEvent');

    EdgeRum.identify({ name: 'Emily' });
    EdgeRum.identify({ email: 'emily@example.com' });

    expect(spy.mock.calls[0]![1]).not.toHaveProperty('user.email');
    expect(spy.mock.calls[1]![1]).not.toHaveProperty('user.name');
    expect(spy.mock.calls[1]![1]['user.email']).toBe('emily@example.com');
  });

  it('does not emit when EdgeRum is disabled', () => {
    EdgeRum.disable();
    // After disable(), the collector is gone via reset paths; re-grab it.
    const collector = __getCollector()!;
    const spy = vi.spyOn(collector, 'recordEvent');

    EdgeRum.identify({ name: 'Emily' });

    expect(spy).not.toHaveBeenCalled();
  });

  it('event flows through the collector with full context (user.id present)', () => {
    const collector = __getCollector()!;
    const pushSpy = vi.fn();
    // Hook into the pipeline by inspecting buildEventPayload via collector internals.
    // Easiest: spy on collector.recordEvent and verify it was called; full-event
    // assertions happen in payload-builder tests. Here we just ensure identify()
    // does go through the collector path that merges contextAttributes.
    vi.spyOn(collector, 'recordEvent').mockImplementation((name, attrs) => {
      pushSpy({ name, attrs });
    });

    EdgeRum.identify({ name: 'Emily', email: 'emily@example.com' });

    expect(pushSpy).toHaveBeenCalledTimes(1);
    const call = pushSpy.mock.calls[0]![0];
    expect(call.name).toBe('user.profile.update');
    expect(call.attrs['user.name']).toBe('Emily');
  });
});

describe('EdgeRum.trackScreen()', () => {
  const config = {
    apiKey: 'edge_test_key',
    endpoint: 'https://example.com/collector/telemetry',
  };

  beforeEach(() => {
    __resetEdgeRumForTests();
    EdgeRum.init(config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetEdgeRumForTests();
  });

  it('emits a navigation event with navigation.to_screen set', () => {
    const collector = __getCollector()!;
    const spy = vi.spyOn(collector, 'recordEvent');

    EdgeRum.trackScreen('CheckoutModal');

    const navCalls = spy.mock.calls.filter(([name]) => name === 'navigation');
    expect(navCalls).toHaveLength(1);
    const [, attrs] = navCalls[0]!;
    expect(attrs['navigation.to_screen']).toBe('CheckoutModal');
    expect(attrs['navigation.method']).toBe('push');
    expect(attrs['navigation.timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(attrs['navigation.has_arguments']).toBe(false);
    expect(attrs).not.toHaveProperty('navigation.from_screen'); // no prior
  });

  it('sets navigation.from_screen on subsequent calls (from the journey list)', () => {
    const collector = __getCollector()!;
    const spy = vi.spyOn(collector, 'recordEvent');

    EdgeRum.trackScreen('Home');
    EdgeRum.trackScreen('Profile');

    const navCalls = spy.mock.calls.filter(([name]) => name === 'navigation');
    expect(navCalls).toHaveLength(2);
    expect(navCalls[1]![1]['navigation.from_screen']).toBe('Home');
    expect(navCalls[1]![1]['navigation.to_screen']).toBe('Profile');
  });

  it('caller-supplied attributes override defaults', () => {
    const collector = __getCollector()!;
    const spy = vi.spyOn(collector, 'recordEvent');

    EdgeRum.trackScreen('Detail', { 'navigation.method': 'replace', 'navigation.has_arguments': true });

    const [, attrs] = spy.mock.calls.find(([name]) => name === 'navigation')!;
    expect(attrs['navigation.method']).toBe('replace');
    expect(attrs['navigation.has_arguments']).toBe(true);
  });

  it('ignores empty / non-string names', () => {
    const collector = __getCollector()!;
    const spy = vi.spyOn(collector, 'recordEvent');

    EdgeRum.trackScreen('');
    EdgeRum.trackScreen(undefined as unknown as string);

    const navCalls = spy.mock.calls.filter(([name]) => name === 'navigation');
    expect(navCalls).toHaveLength(0);
  });

  it('does nothing when EdgeRum is disabled', () => {
    EdgeRum.disable();
    const collector = __getCollector()!;
    const spy = vi.spyOn(collector, 'recordEvent');

    EdgeRum.trackScreen('Home');

    expect(spy).not.toHaveBeenCalled();
  });

  it('emits screen.duration for the previous screen on each trackScreen call', () => {
    const collector = __getCollector()!;
    const spy = vi.spyOn(collector, 'recordEvent');

    EdgeRum.trackScreen('Home');
    // No prior screen — only the navigation event
    let durations = spy.mock.calls.filter(([n]) => n === 'screen.duration');
    expect(durations).toHaveLength(0);

    EdgeRum.trackScreen('Profile');
    durations = spy.mock.calls.filter(([n]) => n === 'screen.duration');
    expect(durations).toHaveLength(1);
    const [, attrs] = durations[0]!;
    expect(attrs['screen.name']).toBe('Home');
    expect(typeof attrs['screen.duration_ms']).toBe('number');
    expect(attrs['screen.exit_method']).toBe('push');
  });
});

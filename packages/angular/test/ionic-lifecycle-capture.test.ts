import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EdgeRum, type EdgeRumConfig } from '@nathanclaire/rum';
import * as rumInternals from '@nathanclaire/rum';
import { __resetEdgeRumForTests } from '../../core/src/EdgeRum';

import { IonicLifecycleCapture } from '../src/IonicLifecycleCapture';

const VALID_CONFIG: EdgeRumConfig = {
  apiKey: 'edge_test_key',
  endpoint: 'https://example.com/collector/telemetry',
  appName: 'TestApp',
  appVersion: '1.0.0',
};

function makeTarget(tagName: string): EventTarget {
  const target = new EventTarget();
  Object.defineProperty(target, 'tagName', { value: tagName });
  return target;
}

function dispatch(bus: EventTarget, type: string, tagName: string): void {
  const event = new Event(type, { bubbles: false });
  Object.defineProperty(event, 'target', { value: makeTarget(tagName) });
  bus.dispatchEvent(event);
}

function spyCollector(): ReturnType<typeof vi.spyOn> {
  const collector = rumInternals.__getCollector();
  if (!collector) throw new Error('collector not initialised in test setup');
  return vi.spyOn(collector, 'recordEvent');
}

function screenDurationCalls(
  spy: ReturnType<typeof vi.spyOn>,
): Array<[string, Record<string, unknown>]> {
  return spy.mock.calls.filter(
    (call) => call[0] === 'screen.duration',
  ) as Array<[string, Record<string, unknown>]>;
}

let bus: EventTarget;

beforeEach(() => {
  __resetEdgeRumForTests();
  EdgeRum.init(VALID_CONFIG);
  bus = new EventTarget();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('IonicLifecycleCapture', () => {
  it('does not emit on ionViewDidEnter — only on exit', () => {
    const spy = spyCollector();
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewDidEnter', 'APP-HOME');

    expect(screenDurationCalls(spy)).toHaveLength(0);
    capture.ngOnDestroy();
  });

  it('emits screen.duration on ionViewDidLeave with the full dwell time', () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const spy = spyCollector();
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewDidEnter', 'APP-PRODUCT');
    now = 5331;
    dispatch(bus, 'ionViewDidLeave', 'APP-PRODUCT');

    const calls = screenDurationCalls(spy);
    expect(calls).toHaveLength(1);
    const attrs = calls[0]![1];
    expect(attrs['screen.name']).toBe('app-product');
    expect(attrs['screen.duration_ms']).toBe(4331);
    expect(attrs['screen.exit_method']).toBe('navigate');
    expect(attrs['screen.timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    capture.ngOnDestroy();
  });

  it('produces a non-negative screen.duration_ms', () => {
    const spy = spyCollector();
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewDidEnter', 'APP-X');
    dispatch(bus, 'ionViewDidLeave', 'APP-X');

    const attrs = screenDurationCalls(spy)[0]![1];
    expect(typeof attrs['screen.duration_ms']).toBe('number');
    expect(attrs['screen.duration_ms'] as number).toBeGreaterThanOrEqual(0);
    capture.ngOnDestroy();
  });

  it('uses the Ionic component tag name as screen.name', () => {
    const spy = spyCollector();
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewDidEnter', 'APP-PRODUCT-DETAIL');
    dispatch(bus, 'ionViewDidLeave', 'APP-PRODUCT-DETAIL');

    const attrs = screenDurationCalls(spy)[0]![1];
    expect(attrs['screen.name']).toBe('app-product-detail');
    capture.ngOnDestroy();
  });

  it('tracks consecutive screens independently', () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const spy = spyCollector();
    const capture = new IonicLifecycleCapture(bus);

    now = 100;
    dispatch(bus, 'ionViewDidEnter', 'APP-A');
    now = 500;
    dispatch(bus, 'ionViewDidLeave', 'APP-A');

    now = 600;
    dispatch(bus, 'ionViewDidEnter', 'APP-B');
    now = 1700;
    dispatch(bus, 'ionViewDidLeave', 'APP-B');

    const calls = screenDurationCalls(spy);
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]['screen.name']).toBe('app-a');
    expect(calls[0]![1]['screen.duration_ms']).toBe(400);
    expect(calls[1]![1]['screen.name']).toBe('app-b');
    expect(calls[1]![1]['screen.duration_ms']).toBe(1100);
    capture.ngOnDestroy();
  });

  it('does not emit when leave fires without a preceding enter', () => {
    // After 3.3.x: no enter ⇒ no active screen ⇒ no event. Synthesis of
    // duration-0 orphans was noise; the processor side handles those cases.
    const spy = spyCollector();
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewDidLeave', 'APP-ORPHAN');

    expect(screenDurationCalls(spy)).toHaveLength(0);
    capture.ngOnDestroy();
  });

  it('does not emit when the leaving event has no target tagName and no preceding enter', () => {
    const spy = spyCollector();
    const capture = new IonicLifecycleCapture(bus);

    bus.dispatchEvent(new Event('ionViewDidLeave'));

    expect(screenDurationCalls(spy)).toHaveLength(0);
    capture.ngOnDestroy();
  });

  it('screen.exit_method reflects the most recent navigation method (pop)', () => {
    rumInternals.__setLastNavigationMethod('pop');
    const spy = spyCollector();
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewDidEnter', 'APP-PROFILE');
    dispatch(bus, 'ionViewDidLeave', 'APP-PROFILE');

    const attrs = screenDurationCalls(spy)[0]![1];
    expect(attrs['screen.exit_method']).toBe('pop');
    capture.ngOnDestroy();
  });

  it('screen.exit_method reflects "replace" when set by the router', () => {
    rumInternals.__setLastNavigationMethod('replace');
    const spy = spyCollector();
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewDidEnter', 'APP-LOGIN');
    dispatch(bus, 'ionViewDidLeave', 'APP-LOGIN');

    const attrs = screenDurationCalls(spy)[0]![1];
    expect(attrs['screen.exit_method']).toBe('replace');
    capture.ngOnDestroy();
  });

  it('stops listening after ngOnDestroy', () => {
    const spy = spyCollector();
    const capture = new IonicLifecycleCapture(bus);

    capture.ngOnDestroy();

    dispatch(bus, 'ionViewDidEnter', 'APP-GONE');
    dispatch(bus, 'ionViewDidLeave', 'APP-GONE');

    expect(screenDurationCalls(spy)).toHaveLength(0);
  });

  it('emits attributes that are only primitives and free of OTel identifiers', () => {
    const spy = spyCollector();
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewDidEnter', 'APP-CHECK');
    dispatch(bus, 'ionViewDidLeave', 'APP-CHECK');

    const attrs = screenDurationCalls(spy)[0]![1];
    for (const value of Object.values(attrs)) {
      expect(typeof value).toMatch(/^(string|number|boolean)$/);
    }
    const serialised = JSON.stringify(attrs);
    expect(serialised).not.toContain('traceId');
    expect(serialised).not.toContain('spanId');
    expect(serialised).not.toContain('resourceSpans');
    expect(serialised).not.toContain('instrumentationScope');
    expect(serialised).not.toContain('opentelemetry');
    capture.ngOnDestroy();
  });

  it('closes the in-flight screen when __flushActiveScreen is called externally', () => {
    // Simulates LifecycleCapture.emitFinalized → callbacks.flushActiveScreen(endReason).
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const spy = spyCollector();
    const capture = new IonicLifecycleCapture(bus);

    now = 1000;
    dispatch(bus, 'ionViewDidEnter', 'APP-DASHBOARD');
    now = 4500;
    rumInternals.__flushActiveScreen('backgrounded');

    const calls = screenDurationCalls(spy);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]['screen.name']).toBe('app-dashboard');
    expect(calls[0]![1]['screen.duration_ms']).toBe(3500);
    expect(calls[0]![1]['screen.exit_method']).toBe('backgrounded');
    capture.ngOnDestroy();
  });
});

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
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewDidEnter', 'APP-HOME');

    expect(spy).not.toHaveBeenCalled();
    capture.ngOnDestroy();
  });

  it('emits screen.duration on ionViewDidLeave with the full dwell time', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewDidEnter', 'APP-PRODUCT');
    now = 5331;
    dispatch(bus, 'ionViewDidLeave', 'APP-PRODUCT');

    expect(spy).toHaveBeenCalledTimes(1);
    const [eventName, attrs] = spy.mock.calls[0]!;
    expect(eventName).toBe('screen.duration');
    const a = attrs as Record<string, unknown>;
    expect(a['screen.name']).toBe('app-product');
    expect(a['screen.duration_ms']).toBe(4331);
    expect(a['screen.exit_method']).toBe('navigate');
    expect(a['screen.timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    capture.ngOnDestroy();
  });

  it('produces a non-negative screen.duration_ms', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewDidEnter', 'APP-X');
    dispatch(bus, 'ionViewDidLeave', 'APP-X');

    const attrs = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(typeof attrs['screen.duration_ms']).toBe('number');
    expect(attrs['screen.duration_ms'] as number).toBeGreaterThanOrEqual(0);
    capture.ngOnDestroy();
  });

  it('uses the Ionic component tag name as screen.name', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewDidEnter', 'APP-PRODUCT-DETAIL');
    dispatch(bus, 'ionViewDidLeave', 'APP-PRODUCT-DETAIL');

    const attrs = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(attrs['screen.name']).toBe('app-product-detail');
    capture.ngOnDestroy();
  });

  it('tracks consecutive screens independently', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const capture = new IonicLifecycleCapture(bus);

    now = 100;
    dispatch(bus, 'ionViewDidEnter', 'APP-A');
    now = 500;
    dispatch(bus, 'ionViewDidLeave', 'APP-A');

    now = 600;
    dispatch(bus, 'ionViewDidEnter', 'APP-B');
    now = 1700;
    dispatch(bus, 'ionViewDidLeave', 'APP-B');

    expect(spy).toHaveBeenCalledTimes(2);
    const first = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(first['screen.name']).toBe('app-a');
    expect(first['screen.duration_ms']).toBe(400);

    const second = spy.mock.calls[1]![1] as Record<string, unknown>;
    expect(second['screen.name']).toBe('app-b');
    expect(second['screen.duration_ms']).toBe(1100);
    capture.ngOnDestroy();
  });

  it('emits with duration 0 when leave fires without a preceding enter', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewDidLeave', 'APP-ORPHAN');

    expect(spy).toHaveBeenCalledTimes(1);
    const attrs = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(attrs['screen.name']).toBe('app-orphan');
    expect(attrs['screen.duration_ms']).toBe(0);
    capture.ngOnDestroy();
  });

  it('falls back to "unknown" when the leaving event has no target tagName', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    const capture = new IonicLifecycleCapture(bus);

    bus.dispatchEvent(new Event('ionViewDidLeave'));

    const attrs = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(attrs['screen.name']).toBe('unknown');
    capture.ngOnDestroy();
  });

  it('stops listening after ngOnDestroy', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    const capture = new IonicLifecycleCapture(bus);

    capture.ngOnDestroy();

    dispatch(bus, 'ionViewDidEnter', 'APP-GONE');
    dispatch(bus, 'ionViewDidLeave', 'APP-GONE');

    expect(spy).not.toHaveBeenCalled();
  });

  it('emits attributes that are only primitives and free of OTel identifiers', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewDidEnter', 'APP-CHECK');
    dispatch(bus, 'ionViewDidLeave', 'APP-CHECK');

    const attrs = spy.mock.calls[0]![1] as Record<string, unknown>;
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
});

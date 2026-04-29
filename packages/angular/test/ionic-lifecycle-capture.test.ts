import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EdgeRum, type EdgeRumConfig } from '@nathanclaire/rum';
import * as rumInternals from '@nathanclaire/rum';
import { __resetEdgeRumForTests } from '../../core/src/EdgeRum';

import { IonicLifecycleCapture } from '../src/IonicLifecycleCapture';

const VALID_CONFIG: EdgeRumConfig = {
  apiKey: 'edge_test_key',
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
  it('emits screen_timing with screen.event="enter" on ionViewDidEnter', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewWillEnter', 'APP-HOME');
    dispatch(bus, 'ionViewDidEnter', 'APP-HOME');

    expect(spy).toHaveBeenCalledTimes(1);
    const [eventName, attrs] = spy.mock.calls[0]!;
    expect(eventName).toBe('screen_timing');
    expect(attrs).toMatchObject({
      'screen.name': 'app-home',
      'screen.event': 'enter',
    });
    capture.ngOnDestroy();
  });

  it('emits screen_timing with screen.event="leave" on ionViewDidLeave', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewWillLeave', 'APP-HOME');
    dispatch(bus, 'ionViewDidLeave', 'APP-HOME');

    expect(spy).toHaveBeenCalledTimes(1);
    const [eventName, attrs] = spy.mock.calls[0]!;
    expect(eventName).toBe('screen_timing');
    expect(attrs).toMatchObject({
      'screen.name': 'app-home',
      'screen.event': 'leave',
    });
    capture.ngOnDestroy();
  });

  it('produces a non-negative screen.duration_ms', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewWillEnter', 'APP-PRODUCT');
    now = 1187;
    dispatch(bus, 'ionViewDidEnter', 'APP-PRODUCT');

    const attrs = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(attrs['screen.duration_ms']).toBe(187);
    expect(typeof attrs['screen.duration_ms']).toBe('number');
    expect(attrs['screen.duration_ms'] as number).toBeGreaterThanOrEqual(0);
    capture.ngOnDestroy();
  });

  it('uses the Ionic component tag name as screen.name', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewWillEnter', 'APP-PRODUCT-DETAIL');
    dispatch(bus, 'ionViewDidEnter', 'APP-PRODUCT-DETAIL');

    const attrs = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(attrs['screen.name']).toBe('app-product-detail');
    capture.ngOnDestroy();
  });

  it('tracks enter and leave independently across interleaved events', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewWillEnter', 'APP-A');
    dispatch(bus, 'ionViewWillLeave', 'APP-B');
    dispatch(bus, 'ionViewDidEnter', 'APP-A');
    dispatch(bus, 'ionViewDidLeave', 'APP-B');

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![1]).toMatchObject({
      'screen.name': 'app-a',
      'screen.event': 'enter',
    });
    expect(spy.mock.calls[1]![1]).toMatchObject({
      'screen.name': 'app-b',
      'screen.event': 'leave',
    });
    capture.ngOnDestroy();
  });

  it('emits duration 0 when Did fires without a preceding Will', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewDidEnter', 'APP-ORPHAN');

    expect(spy).toHaveBeenCalledTimes(1);
    const attrs = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(attrs['screen.duration_ms']).toBe(0);
    expect(attrs['screen.name']).toBe('app-orphan');
    capture.ngOnDestroy();
  });

  it('falls back to "unknown" when the event has no target tagName', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    const capture = new IonicLifecycleCapture(bus);

    bus.dispatchEvent(new Event('ionViewWillEnter'));
    bus.dispatchEvent(new Event('ionViewDidEnter'));

    const attrs = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(attrs['screen.name']).toBe('unknown');
    capture.ngOnDestroy();
  });

  it('stops listening after ngOnDestroy', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    const capture = new IonicLifecycleCapture(bus);

    capture.ngOnDestroy();

    dispatch(bus, 'ionViewWillEnter', 'APP-GONE');
    dispatch(bus, 'ionViewDidEnter', 'APP-GONE');

    expect(spy).not.toHaveBeenCalled();
  });

  it('emits attributes that are only primitives and free of OTel identifiers', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewWillEnter', 'APP-CHECK');
    dispatch(bus, 'ionViewDidEnter', 'APP-CHECK');

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

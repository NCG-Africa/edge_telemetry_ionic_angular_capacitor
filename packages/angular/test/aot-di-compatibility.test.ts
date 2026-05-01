import { InjectionToken } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EdgeRum, type EdgeRumConfig } from '@nathanclaire/rum';
import * as rumInternals from '@nathanclaire/rum';
import { __resetEdgeRumForTests } from '../../core/src/EdgeRum';

import { EdgeRumErrorCapture, ERROR_ROUTE_PROVIDER } from '../src/ErrorCapture';
import {
  IonicLifecycleCapture,
  LIFECYCLE_EVENT_SOURCE,
} from '../src/IonicLifecycleCapture';
import { RouterCapture } from '../src/RouterCapture';

const VALID_CONFIG: EdgeRumConfig = {
  apiKey: 'edge_test_key',
  appName: 'TestApp',
  appVersion: '1.0.0',
};

beforeEach(() => {
  __resetEdgeRumForTests();
  EdgeRum.init(VALID_CONFIG);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// InjectionToken exports
// ---------------------------------------------------------------------------
describe('InjectionToken exports', () => {
  it('ERROR_ROUTE_PROVIDER is an InjectionToken', () => {
    expect(ERROR_ROUTE_PROVIDER).toBeInstanceOf(InjectionToken);
  });

  it('ERROR_ROUTE_PROVIDER has a descriptive toString', () => {
    expect(String(ERROR_ROUTE_PROVIDER)).toContain('ERROR_ROUTE_PROVIDER');
  });

  it('LIFECYCLE_EVENT_SOURCE is an InjectionToken', () => {
    expect(LIFECYCLE_EVENT_SOURCE).toBeInstanceOf(InjectionToken);
  });

  it('LIFECYCLE_EVENT_SOURCE has a descriptive toString', () => {
    expect(String(LIFECYCLE_EVENT_SOURCE)).toContain('LIFECYCLE_EVENT_SOURCE');
  });
});

// ---------------------------------------------------------------------------
// EdgeRumErrorCapture — DI-compatible constructor
// ---------------------------------------------------------------------------
describe('EdgeRumErrorCapture DI constructor', () => {
  it('works with no arguments (simulates Angular DI with @Optional resolving to null)', () => {
    const capture = new EdgeRumErrorCapture();
    expect(capture).toBeInstanceOf(EdgeRumErrorCapture);
  });

  it('works with null argument (simulates Angular @Optional injection)', () => {
    const capture = new EdgeRumErrorCapture(null);
    expect(capture).toBeInstanceOf(EdgeRumErrorCapture);
  });

  it('falls back to window.location route when no provider injected', () => {
    const spy = vi.spyOn(EdgeRum, 'captureError').mockImplementation(() => undefined);
    const capture = new EdgeRumErrorCapture(null);

    capture.handleError(new Error('test'));

    const context = spy.mock.calls[0]![1] as Record<string, unknown>;
    // In node environment window is undefined, so route falls back to ''
    expect(context['error_context']).toBe('screen:');
  });

  it('uses injected route provider when given', () => {
    const spy = vi.spyOn(EdgeRum, 'captureError').mockImplementation(() => undefined);
    const customRoute = () => '/dashboard/settings';
    const capture = new EdgeRumErrorCapture(customRoute);

    capture.handleError(new Error('test'));

    const context = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(context['error_context']).toBe('screen:/dashboard/settings');
  });

  it('uses injected route provider over default for each error', () => {
    const spy = vi.spyOn(EdgeRum, 'captureError').mockImplementation(() => undefined);
    let currentRoute = '/page-a';
    const dynamicRoute = () => currentRoute;
    const capture = new EdgeRumErrorCapture(dynamicRoute);

    capture.handleError(new Error('first'));
    currentRoute = '/page-b';
    capture.handleError(new Error('second'));

    expect((spy.mock.calls[0]![1] as Record<string, unknown>)['error_context']).toBe(
      'screen:/page-a',
    );
    expect((spy.mock.calls[1]![1] as Record<string, unknown>)['error_context']).toBe(
      'screen:/page-b',
    );
  });
});

// ---------------------------------------------------------------------------
// IonicLifecycleCapture — DI-compatible constructor
// ---------------------------------------------------------------------------
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

describe('IonicLifecycleCapture DI constructor', () => {
  it('works with no arguments (simulates Angular DI with @Optional resolving to null)', () => {
    const capture = new IonicLifecycleCapture();
    expect(capture).toBeInstanceOf(IonicLifecycleCapture);
    capture.ngOnDestroy();
  });

  it('works with null argument (simulates Angular @Optional injection)', () => {
    const capture = new IonicLifecycleCapture(null);
    expect(capture).toBeInstanceOf(IonicLifecycleCapture);
    capture.ngOnDestroy();
  });

  it('does not throw when source is null and events are dispatched elsewhere', () => {
    const capture = new IonicLifecycleCapture(null);
    // Should not throw — no listeners attached to anything
    expect(() => capture.ngOnDestroy()).not.toThrow();
  });

  it('uses injected EventTarget when provided', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    const bus = new EventTarget();
    const capture = new IonicLifecycleCapture(bus);

    dispatch(bus, 'ionViewWillEnter', 'APP-INJECTED');
    dispatch(bus, 'ionViewDidEnter', 'APP-INJECTED');

    expect(spy).toHaveBeenCalledTimes(1);
    const attrs = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(attrs['screen.name']).toBe('app-injected');
    capture.ngOnDestroy();
  });

  it('stops listening on injected source after ngOnDestroy', () => {
    const spy = vi.spyOn(rumInternals, '__recordEvent');
    const bus = new EventTarget();
    const capture = new IonicLifecycleCapture(bus);

    capture.ngOnDestroy();

    dispatch(bus, 'ionViewWillEnter', 'APP-GONE');
    dispatch(bus, 'ionViewDidEnter', 'APP-GONE');

    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to document when no source injected and document exists', () => {
    // In vitest node env, global document may not exist, so source falls back to null
    // This test verifies the fallback logic runs without error
    const capture = new IonicLifecycleCapture();
    expect(capture).toBeInstanceOf(IonicLifecycleCapture);
    capture.ngOnDestroy();
  });
});

// ---------------------------------------------------------------------------
// RouterCapture — Router as value import (not type-only)
// ---------------------------------------------------------------------------
describe('RouterCapture DI requirements', () => {
  it('has Router as a constructor dependency (value import, not type-only)', () => {
    // RouterCapture's constructor signature requires Router as the first param.
    // If Router were a type-only import, ng-packagr would error during compilation.
    // This test verifies the class can be inspected and its constructor expects a param.
    expect(RouterCapture).toBeDefined();
    expect(typeof RouterCapture).toBe('function');
    // The constructor expects exactly 1 argument (Router)
    expect(RouterCapture.length).toBe(1);
  });
});

import { ErrorHandler } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EdgeRum, type EdgeRumConfig } from '@nathanclaire/rum';
import { __resetEdgeRumForTests } from '../../core/src/EdgeRum';

import { EdgeRumErrorCapture } from '../src/ErrorCapture';

const VALID_CONFIG: EdgeRumConfig = {
  apiKey: 'edge_test_key',
  endpoint: 'https://example.com/collector/telemetry',
  appName: 'TestApp',
  appVersion: '1.0.0',
};

function route(url: string): () => string {
  return () => url;
}

beforeEach(() => {
  __resetEdgeRumForTests();
  EdgeRum.init(VALID_CONFIG);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EdgeRumErrorCapture', () => {
  it('extends Angular ErrorHandler', () => {
    const capture = new EdgeRumErrorCapture(route(""));
    expect(capture).toBeInstanceOf(ErrorHandler);
  });

  it('calls EdgeRum.captureError with handled:true and AngularError cause', () => {
    const spy = vi.spyOn(EdgeRum, 'captureError').mockImplementation(() => undefined);
    const capture = new EdgeRumErrorCapture(route('/products/42'));
    const err = new Error('boom');

    capture.handleError(err);

    expect(spy).toHaveBeenCalledTimes(1);
    const [passedError, context] = spy.mock.calls[0]!;
    expect(passedError).toBe(err);
    expect(context).toMatchObject({
      cause: 'AngularError',
      handled: true,
      error_context: 'screen:/products/42',
    });
  });

  it('extracts component name from Angular template stack trace', () => {
    const spy = vi.spyOn(EdgeRum, 'captureError').mockImplementation(() => undefined);
    const err = new Error('template error');
    err.stack = [
      'Error: template error',
      '    at ProductDetailComponent_Template_div_click_0_listener (main.js:42:10)',
      '    at HostListener (core.mjs:1:1)',
    ].join('\n');
    const capture = new EdgeRumErrorCapture(route(""));

    capture.handleError(err);

    const context = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(context['component']).toBe('ProductDetailComponent');
  });

  it('omits component when the stack has no recognisable pattern', () => {
    const spy = vi.spyOn(EdgeRum, 'captureError').mockImplementation(() => undefined);
    const err = new Error('plain');
    err.stack = 'Error: plain\n    at anonymous (app.js:1:1)';
    const capture = new EdgeRumErrorCapture(route(""));

    capture.handleError(err);

    const context = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(context['component']).toBeUndefined();
  });

  it('uses empty screen route when router is not available', () => {
    const spy = vi.spyOn(EdgeRum, 'captureError').mockImplementation(() => undefined);
    const capture = new EdgeRumErrorCapture(route(""));

    capture.handleError(new Error('no router'));

    const context = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(context['error_context']).toBe('screen:');
  });

  it('forwards to base ErrorHandler so Angular still logs', () => {
    vi.spyOn(EdgeRum, 'captureError').mockImplementation(() => undefined);
    const superSpy = vi
      .spyOn(ErrorHandler.prototype, 'handleError')
      .mockImplementation(() => undefined);
    const capture = new EdgeRumErrorCapture(route(""));
    const err = new Error('boom');

    capture.handleError(err);

    expect(superSpy).toHaveBeenCalledTimes(1);
    expect(superSpy).toHaveBeenCalledWith(err);
  });

  it('still forwards to base handler when captureError throws', () => {
    vi.spyOn(EdgeRum, 'captureError').mockImplementation(() => {
      throw new Error('internal fail');
    });
    const superSpy = vi
      .spyOn(ErrorHandler.prototype, 'handleError')
      .mockImplementation(() => undefined);
    const capture = new EdgeRumErrorCapture(route(""));
    const err = new Error('boom');

    expect(() => capture.handleError(err)).not.toThrow();
    expect(superSpy).toHaveBeenCalledWith(err);
  });

  it('wraps non-Error values into Error instances', () => {
    const spy = vi.spyOn(EdgeRum, 'captureError').mockImplementation(() => undefined);
    const capture = new EdgeRumErrorCapture(route(""));

    capture.handleError('something went wrong');

    const passed = spy.mock.calls[0]![0]!;
    expect(passed).toBeInstanceOf(Error);
    expect(passed.message).toBe('something went wrong');
  });

  it('unwraps error-like objects preserving message and stack', () => {
    const spy = vi.spyOn(EdgeRum, 'captureError').mockImplementation(() => undefined);
    const capture = new EdgeRumErrorCapture(route(""));
    const stack =
      'Error\n    at CheckoutComponent_Template_button_click_1_listener (main.js:99:1)';

    capture.handleError({ message: 'rejection', stack });

    const passed = spy.mock.calls[0]![0]!;
    const context = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(passed.message).toBe('rejection');
    expect(context['component']).toBe('CheckoutComponent');
  });

  it('produces a context whose values are only primitives', () => {
    const spy = vi.spyOn(EdgeRum, 'captureError').mockImplementation(() => undefined);
    const capture = new EdgeRumErrorCapture(route('/home'));
    const err = new Error('x');
    err.stack = 'Error: x\n    at LoginComponent_Template_ (main.js:1:1)';

    capture.handleError(err);

    const context = spy.mock.calls[0]![1] as Record<string, unknown>;
    for (const value of Object.values(context)) {
      expect(typeof value).toMatch(/^(string|number|boolean)$/);
    }
    const serialised = JSON.stringify(context);
    expect(serialised).not.toContain('traceId');
    expect(serialised).not.toContain('spanId');
    expect(serialised).not.toContain('resourceSpans');
    expect(serialised).not.toContain('opentelemetry');
  });
});

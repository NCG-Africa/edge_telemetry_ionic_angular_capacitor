import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerErrorCapture } from '../src/instrumentation/errors';
import type { ErrorEventAttributes } from '../src/instrumentation/errors';

type RecordedEvent = {
  eventName: 'app.crash';
  attributes: ErrorEventAttributes;
};

function createTarget() {
  const listeners: Record<string, EventListener[]> = {};
  return {
    addEventListener(type: string, listener: EventListener) {
      (listeners[type] ||= []).push(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      const arr = listeners[type];
      if (!arr) return;
      const i = arr.indexOf(listener);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatch(type: string, event: unknown) {
      for (const l of listeners[type] ?? []) l(event as Event);
    },
    count(type: string) {
      return (listeners[type] ?? []).length;
    },
  };
}

describe('registerErrorCapture', () => {
  let recorded: RecordedEvent[];
  let flushes: number;
  let target: ReturnType<typeof createTarget>;

  function setup(overrides?: { getCurrentRoute?: () => string; recordEvent?: (e: 'app.crash', a: ErrorEventAttributes) => void; flushPipeline?: () => void }) {
    return registerErrorCapture({
      target: target as unknown as Window,
      recordEvent:
        overrides?.recordEvent ??
        ((eventName, attributes) => {
          recorded.push({ eventName, attributes: { ...attributes } });
        }),
      flushPipeline:
        overrides?.flushPipeline ??
        (() => {
          flushes += 1;
        }),
      getCurrentRoute: overrides?.getCurrentRoute ?? (() => '/home'),
    });
  }

  beforeEach(() => {
    recorded = [];
    flushes = 0;
    target = createTarget();
  });

  it('captures window error events as app.crash with handled:false, is_fatal:false', () => {
    setup();
    const err = new TypeError("Cannot read properties of undefined (reading 'x')");
    err.stack = 'TypeError: boom\n  at foo';
    target.dispatch('error', {
      message: err.message,
      error: err,
    });

    expect(recorded).toHaveLength(1);
    const event = recorded[0]!;
    expect(event.eventName).toBe('app.crash');
    expect(event.attributes.exception_type).toBe('TypeError');
    expect(event.attributes.message).toBe(err.message);
    expect(event.attributes.stacktrace).toBe('TypeError: boom\n  at foo');
    expect(event.attributes.is_fatal).toBe(false);
    expect(event.attributes.handled).toBe(false);
    expect(event.attributes.cause).toBe('UnhandledError');
    expect(event.attributes.error_context).toBe('screen:/home');
    expect(event.attributes.runtime).toBe('webview');
  });

  it('flushes pipeline immediately on window.error', () => {
    setup();
    target.dispatch('error', { message: 'x', error: new Error('x') });
    expect(flushes).toBe(1);
  });

  it('captures unhandledrejection with exception_type:UnhandledRejection and cause:PromiseRejection', () => {
    setup();
    const reason = new Error('rejected');
    reason.stack = 'Error: rejected\n  at p';
    target.dispatch('unhandledrejection', { reason });

    expect(recorded).toHaveLength(1);
    const event = recorded[0]!;
    expect(event.attributes.exception_type).toBe('UnhandledRejection');
    expect(event.attributes.cause).toBe('PromiseRejection');
    expect(event.attributes.message).toBe('rejected');
    expect(event.attributes.stacktrace).toBe('Error: rejected\n  at p');
    expect(event.attributes.is_fatal).toBe(false);
    expect(event.attributes.handled).toBe(false);
    expect(event.attributes.runtime).toBe('webview');
    expect(flushes).toBe(1);
  });

  it('handles non-Error rejection reasons (string)', () => {
    setup();
    target.dispatch('unhandledrejection', { reason: 'nope' });
    expect(recorded[0]!.attributes.message).toBe('nope');
    expect(recorded[0]!.attributes.stacktrace).toBe('');
    expect(recorded[0]!.attributes.exception_type).toBe('UnhandledRejection');
  });

  it('error_context reflects current route at capture time', () => {
    let route = '/a';
    setup({ getCurrentRoute: () => route });
    target.dispatch('error', { message: 'm', error: new Error('m') });
    expect(recorded[0]!.attributes.error_context).toBe('screen:/a');

    route = '/products/42';
    target.dispatch('error', { message: 'm2', error: new Error('m2') });
    expect(recorded[1]!.attributes.error_context).toBe('screen:/products/42');
  });

  it('falls back to screen:unknown when getCurrentRoute throws', () => {
    setup({
      getCurrentRoute: () => {
        throw new Error('no route');
      },
    });
    target.dispatch('error', { message: 'm', error: new Error('m') });
    expect(recorded[0]!.attributes.error_context).toBe('screen:unknown');
  });

  it('does not propagate errors from recordEvent to the event handler', () => {
    setup({
      recordEvent: () => {
        throw new Error('transport exploded');
      },
    });
    expect(() =>
      target.dispatch('error', { message: 'm', error: new Error('m') }),
    ).not.toThrow();
    expect(() =>
      target.dispatch('unhandledrejection', { reason: new Error('r') }),
    ).not.toThrow();
  });

  it('does not propagate errors from flushPipeline to the event handler', () => {
    setup({
      flushPipeline: () => {
        throw new Error('flush exploded');
      },
    });
    expect(() =>
      target.dispatch('error', { message: 'm', error: new Error('m') }),
    ).not.toThrow();
  });

  it('all attribute values are primitives (string | number | boolean)', () => {
    setup();
    target.dispatch('error', { message: 'm', error: new Error('m') });
    for (const v of Object.values(recorded[0]!.attributes)) {
      expect(['string', 'number', 'boolean']).toContain(typeof v);
    }
  });

  it('emitted payload contains no OTel identifiers', () => {
    setup();
    target.dispatch('error', { message: 'm', error: new Error('m') });
    target.dispatch('unhandledrejection', { reason: new Error('r') });
    const json = JSON.stringify(recorded);
    expect(json).not.toMatch(/traceId/i);
    expect(json).not.toMatch(/spanId/i);
    expect(json).not.toMatch(/resourceSpans/i);
    expect(json).not.toMatch(/instrumentationScope/i);
    expect(json).not.toMatch(/opentelemetry/i);
  });

  it('uses field names that match the Android SDK v2.0.0 exactly (plus breadcrumb attachment)', () => {
    setup();
    target.dispatch('error', { message: 'm', error: new Error('m') });
    const keys = Object.keys(recorded[0]!.attributes).sort();
    // Android SDK v2 core keys
    const androidKeys = [
      'cause',
      'error_context',
      'exception_type',
      'handled',
      'is_fatal',
      'message',
      'runtime',
      'stacktrace',
    ];
    for (const k of androidKeys) {
      expect(keys).toContain(k);
    }
    // Plus the SDK's breadcrumb attachment (additive, not a wire-contract break)
    expect(keys).toContain('crash.breadcrumbs');
    expect(keys).toContain('crash.breadcrumb_count');
  });

  it('handles missing error object on ErrorEvent gracefully', () => {
    setup();
    target.dispatch('error', { message: 'boom', error: null });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.attributes.exception_type).toBe('Error');
    expect(recorded[0]!.attributes.message).toBe('boom');
    expect(recorded[0]!.attributes.stacktrace).toBe('');
  });

  it('dispose() removes registered listeners', () => {
    const handle = setup();
    expect(target.count('error')).toBe(1);
    expect(target.count('unhandledrejection')).toBe(1);
    handle.dispose();
    expect(target.count('error')).toBe(0);
    expect(target.count('unhandledrejection')).toBe(0);
  });

  it('no-ops when no window target is available', () => {
    const handle = registerErrorCapture({
      target: undefined,
      recordEvent: () => {
        throw new Error('should not be called');
      },
      flushPipeline: () => undefined,
      getCurrentRoute: () => '/x',
    });
    expect(() => handle.dispose()).not.toThrow();
  });

  it('calls recordEvent and flushPipeline in order (record before flush)', () => {
    const calls: string[] = [];
    setup({
      recordEvent: () => calls.push('record'),
      flushPipeline: () => calls.push('flush'),
    });
    target.dispatch('error', { message: 'm', error: new Error('m') });
    expect(calls).toEqual(['record', 'flush']);
  });

  it('spy on flushPipeline is called exactly once per event', () => {
    const flush = vi.fn();
    setup({ flushPipeline: flush });
    target.dispatch('error', { message: 'm', error: new Error('m') });
    target.dispatch('unhandledrejection', { reason: new Error('r') });
    expect(flush).toHaveBeenCalledTimes(2);
  });
});

import { registerConsoleErrorCapture } from '../src/instrumentation/errors';
import { breadcrumbs } from '../src/internal/breadcrumbs';

describe('registerConsoleErrorCapture (ADR-029: breadcrumbs only)', () => {
  let crumbs: string[];
  let consoleStub: Console;
  let originalError: ReturnType<typeof vi.fn>;
  let originalWarn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    crumbs = [];
    originalError = vi.fn();
    originalWarn = vi.fn();
    consoleStub = {
      error: originalError,
      warn: originalWarn,
    } as unknown as Console;
  });

  function setup() {
    return registerConsoleErrorCapture({
      consoleTarget: consoleStub,
      pushBreadcrumb: (message) => crumbs.push(message),
    });
  }

  it('routes console.error to a breadcrumb — never mints an event', () => {
    setup();
    consoleStub.error('something broke');
    expect(crumbs).toEqual(['something broke']);
  });

  it('does not wrap console.warn', () => {
    setup();
    consoleStub.warn('deprecated thing');
    expect(crumbs).toHaveLength(0);
    expect(originalWarn).toHaveBeenCalledWith('deprecated thing');
    // warn was not reassigned
    expect(consoleStub.warn).toBe(originalWarn);
  });

  it('still calls the original console.error after wrapping', () => {
    setup();
    consoleStub.error('forwarded');
    expect(originalError).toHaveBeenCalledWith('forwarded');
  });

  it('uses Error.message when first arg is an Error', () => {
    setup();
    consoleStub.error(new TypeError('cannot read x of undefined'));
    expect(crumbs[0]).toBe('cannot read x of undefined');
  });

  it('joins multi-arg string + object messages when no Error is present', () => {
    setup();
    consoleStub.error('user', 42, { foo: 'bar' });
    expect(crumbs[0]).toBe('user 42 {"foo":"bar"}');
  });

  it('dispose() stops capturing — subsequent console.error does not record', () => {
    const handle = setup();
    consoleStub.error('before-dispose');
    expect(crumbs).toHaveLength(1);
    handle.dispose();
    consoleStub.error('after-dispose');
    expect(crumbs).toHaveLength(1);
    expect(originalError).toHaveBeenCalledTimes(2);
  });

  it('returns a no-op handle when consoleTarget lacks console.error', () => {
    const handle = registerConsoleErrorCapture({
      consoleTarget: {} as unknown as Console,
      pushBreadcrumb: (message) => crumbs.push(message),
    });
    expect(typeof handle.dispose).toBe('function');
    expect(crumbs).toHaveLength(0);
  });

  it('survives a pushBreadcrumb throw — the original console.error still fires', () => {
    registerConsoleErrorCapture({
      consoleTarget: consoleStub,
      pushBreadcrumb: () => {
        throw new Error('crumb-failure');
      },
    });
    expect(() => consoleStub.error('x')).not.toThrow();
    expect(originalError).toHaveBeenCalledWith('x');
  });

  it('collapses consecutive duplicate console lines into one crumb with count (real ring)', () => {
    breadcrumbs.reset();
    registerConsoleErrorCapture({ consoleTarget: consoleStub });
    consoleStub.error('boom');
    consoleStub.error('boom');
    consoleStub.error('boom');
    consoleStub.error('different');
    consoleStub.error('boom');

    const snap = breadcrumbs.snapshot();
    expect(snap).toHaveLength(3);
    expect(snap[0]).toMatchObject({ type: 'console.error', name: 'boom', count: 3 });
    expect(snap[1]).toMatchObject({ type: 'console.error', name: 'different', count: 1 });
    expect(snap[2]).toMatchObject({ type: 'console.error', name: 'boom', count: 1 });
    breadcrumbs.reset();
  });
});

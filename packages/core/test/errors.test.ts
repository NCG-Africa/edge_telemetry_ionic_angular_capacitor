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

  it('captures window error events as app.crash on the catalogue error.* keys (E9, #149)', () => {
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
    expect(event.attributes).toEqual({
      'error.type': 'TypeError',
      'error.message': err.message,
      'error.stacktrace': 'TypeError: boom\n  at foo',
      'error.cause': 'unhandled_exception',
      'error.source': 'webview',
      'error.breadcrumbs': '[]',
      'screen.name': '/home',
    });
  });

  it('flushes pipeline immediately on window.error', () => {
    setup();
    target.dispatch('error', { message: 'x', error: new Error('x') });
    expect(flushes).toBe(1);
  });

  it('captures unhandledrejection with the Error name and error.cause promise_rejection', () => {
    setup();
    const reason = new Error('rejected');
    reason.stack = 'Error: rejected\n  at p';
    target.dispatch('unhandledrejection', { reason });

    expect(recorded).toHaveLength(1);
    const event = recorded[0]!;
    expect(event.eventName).toBe('app.crash');
    expect(event.attributes['error.type']).toBe('Error');
    expect(event.attributes['error.cause']).toBe('promise_rejection');
    expect(event.attributes['error.message']).toBe('rejected');
    expect(event.attributes['error.stacktrace']).toBe('Error: rejected\n  at p');
    expect(flushes).toBe(1);
  });

  it('handles non-Error rejection reasons (string)', () => {
    setup();
    target.dispatch('unhandledrejection', { reason: 'nope' });
    expect(recorded[0]!.attributes['error.message']).toBe('nope');
    expect(recorded[0]!.attributes['error.stacktrace']).toBe('');
    expect(recorded[0]!.attributes['error.type']).toBe('UnhandledRejection');
  });

  it('screen.name reflects current route at capture time', () => {
    let route = '/a';
    setup({ getCurrentRoute: () => route });
    target.dispatch('error', { message: 'm', error: new Error('m') });
    expect(recorded[0]!.attributes['screen.name']).toBe('/a');

    route = '/products/42';
    target.dispatch('error', { message: 'm2', error: new Error('m2') });
    expect(recorded[1]!.attributes['screen.name']).toBe('/products/42');
  });

  it('falls back to screen.name unknown when getCurrentRoute throws', () => {
    setup({
      getCurrentRoute: () => {
        throw new Error('no route');
      },
    });
    target.dispatch('error', { message: 'm', error: new Error('m') });
    expect(recorded[0]!.attributes['screen.name']).toBe('unknown');
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

  it('sends only catalogue keys: no legacy is_fatal / handled / runtime / cause names (#149)', () => {
    setup();
    target.dispatch('error', { message: 'm', error: new Error('m') });
    expect(Object.keys(recorded[0]!.attributes).sort()).toEqual([
      'error.breadcrumbs', 'error.cause', 'error.message', 'error.source', 'error.stacktrace', 'error.type', 'screen.name',
    ]);
  });

  it('handles missing error object on ErrorEvent gracefully', () => {
    setup();
    target.dispatch('error', { message: 'boom', error: null });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.attributes['error.type']).toBe('Error');
    expect(recorded[0]!.attributes['error.message']).toBe('boom');
    expect(recorded[0]!.attributes['error.stacktrace']).toBe('');
  });

  it('falls back to the ErrorEvent location as the frame, normalised (Y3)', () => {
    setup();
    target.dispatch('error', { message: 'Script error.', error: null, filename: 'capacitor://localhost/main.js', lineno: 3, colno: 7 });
    expect(recorded[0]!.attributes['error.stacktrace']).toBe('at app:///main.js:3:7');
  });

  it('normalises frames in the message and stack, never keeps a raw copy (Y3)', () => {
    setup();
    const err = new Error('bad chunk https://localhost/chunk-1.js');
    err.stack = 'Error: x\n    at f (https://localhost/main.js?v=2:1:2)\n    at g (https://cdn.example.com/lib.js:3:4)';
    target.dispatch('error', { message: err.message, error: err });
    const a = recorded[0]!.attributes;
    expect(a['error.message']).toBe('bad chunk app:///chunk-1.js');
    expect(a['error.stacktrace']).toBe('Error: x\n    at f (app:///main.js:1:2)\n    at g (https://cdn.example.com/lib.js:3:4)');
    expect(JSON.stringify(a)).not.toContain('localhost');
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

import { normaliseStack } from '../src/instrumentation/errors';

describe('app:/// frame normalisation (Y3)', () => {
  it.each([
    ['capacitor://localhost/main.js:10:5', 'app:///main.js:10:5'],
    ['https://localhost/main.js:10:5', 'app:///main.js:10:5'],
    ['http://localhost/main.js:10:5', 'app:///main.js:10:5'],
    ['ionic://localhost/main.js:10:5', 'app:///main.js:10:5'],
    ['app://localhost/main.js:10:5', 'app:///main.js:10:5'],
    ['https://localhost/assets/js/chunk-ABC.js?v=1#x:1:2', 'app:///assets/js/chunk-ABC.js:1:2'],
    ['    at f (capacitor://localhost/main.js:1:2)', '    at f (app:///main.js:1:2)'],
    ['f@capacitor://localhost/main.js:1:2', 'f@app:///main.js:1:2'],
    ['capacitor://localhost/main.js', 'app:///main.js'],
  ])('%s → %s', (from, to) => {
    expect(normaliseStack(from)).toBe(to);
  });

  it.each([
    'https://cdn.example.com/lib.js:1:2',
    'http://localhost:8100/main.js:1:2', // live-reload dev server: port isn't ours
    'https://localhost.evil.com/main.js:1:2',
    'http://192.168.1.5:8100/main.js:1:2',
  ])('leaves %s untouched', (frame) => {
    expect(normaliseStack(frame)).toBe(frame);
  });
});

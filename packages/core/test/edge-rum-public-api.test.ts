import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EdgeRum,
  __getCollector,
  __getPipeline,
  __getCurrentRoute,
  __setCurrentRoute,
  __subscribeToCurrentRoute,
  __resetEdgeRumForTests,
} from '../src/EdgeRum';
import { breadcrumbs } from '../src/internal/breadcrumbs';

const config = {
  apiKey: 'edge_test_key',
  endpoint: 'https://example.com/collector/telemetry',
};

describe('EdgeRum public API — broad behavior', () => {
  beforeEach(() => {
    __resetEdgeRumForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetEdgeRumForTests();
  });

  describe('disable / enable lifecycle', () => {
    it('disable() stops subsequent events from being recorded', () => {
      EdgeRum.init(config);
      const collector = __getCollector()!;
      const spy = vi.spyOn(collector, 'recordEvent');
      spy.mockClear();

      EdgeRum.disable();
      EdgeRum.track('after-disable');

      expect(spy).not.toHaveBeenCalled();
    });

    it('enable() resumes event capture', () => {
      EdgeRum.init(config);
      EdgeRum.disable();
      EdgeRum.enable();
      const collector = __getCollector()!;
      const spy = vi.spyOn(collector, 'recordEvent');

      EdgeRum.track('after-enable');

      const customEmits = spy.mock.calls.filter(([name]) => name === 'custom_event');
      expect(customEmits).toHaveLength(1);
    });

    it('disable() stops the pipeline timer', () => {
      EdgeRum.init(config);
      const pipeline = __getPipeline()!;
      const stopSpy = vi.spyOn(pipeline, 'stop');

      EdgeRum.disable();

      expect(stopSpy).toHaveBeenCalled();
    });

    it('throws if methods are called before init()', () => {
      __resetEdgeRumForTests();
      expect(() => EdgeRum.track('x')).toThrowError(/init\(\) must be called/);
      expect(() => EdgeRum.identify({})).toThrowError(/init\(\) must be called/);
      expect(() => EdgeRum.captureError(new Error('x'))).toThrowError(/init\(\) must be called/);
      expect(() => EdgeRum.trackScreen('x')).toThrowError(/init\(\) must be called/);
      expect(() => EdgeRum.time('x')).toThrowError(/init\(\) must be called/);
    });
  });

  describe('captureError', () => {
    it('emits app.crash with handled:true and cause=ManualCapture', () => {
      EdgeRum.init(config);
      const collector = __getCollector()!;
      const spy = vi.spyOn(collector, 'recordEvent');

      EdgeRum.captureError(new TypeError('manual'));

      const crash = spy.mock.calls.find(([n]) => n === 'app.crash');
      expect(crash).toBeDefined();
      const [, attrs] = crash!;
      expect(attrs['cause']).toBe('ManualCapture');
      expect(attrs['handled']).toBe(true);
      expect(attrs['is_fatal']).toBe(false);
      expect(attrs['exception_type']).toBe('TypeError');
      expect(attrs['message']).toBe('manual');
    });

    it('attaches breadcrumbs to the crash event', () => {
      EdgeRum.init(config);
      const collector = __getCollector()!;
      // Generate some breadcrumbs by tracking events
      EdgeRum.track('nav-1');
      EdgeRum.track('nav-2');
      const spy = vi.spyOn(collector, 'recordEvent');

      EdgeRum.captureError(new Error('boom'));

      const crash = spy.mock.calls.find(([n]) => n === 'app.crash');
      const [, attrs] = crash!;
      expect(attrs).toHaveProperty('crash.breadcrumbs');
      expect(attrs).toHaveProperty('crash.breadcrumb_count');
      expect(typeof attrs['crash.breadcrumbs']).toBe('string');
      // Must be JSON-parseable
      const crumbs = JSON.parse(attrs['crash.breadcrumbs'] as string);
      expect(Array.isArray(crumbs)).toBe(true);
    });

    it('shallow-flattens the context arg — primitives kept, nested dropped', () => {
      EdgeRum.init(config);
      const collector = __getCollector()!;
      const spy = vi.spyOn(collector, 'recordEvent');

      EdgeRum.captureError(new Error('x'), {
        step: 'confirm',
        amount: 99.99,
        ok: true,
        nested: { foo: 'bar' },         // dropped
        list: [1, 2, 3],                 // dropped
      });

      const crash = spy.mock.calls.find(([n]) => n === 'app.crash');
      const [, attrs] = crash!;
      expect(attrs['step']).toBe('confirm');
      expect(attrs['amount']).toBe(99.99);
      expect(attrs['ok']).toBe(true);
      expect(attrs).not.toHaveProperty('nested');
      expect(attrs).not.toHaveProperty('list');
    });

    it('does nothing when disabled', () => {
      EdgeRum.init(config);
      EdgeRum.disable();
      const collector = __getCollector()!;
      const spy = vi.spyOn(collector, 'recordEvent');

      EdgeRum.captureError(new Error('x'));

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('time().end() — custom metric', () => {
    it('emits a metric item with elapsed ms as value', async () => {
      EdgeRum.init(config);
      const collector = __getCollector()!;
      const spy = vi.spyOn(collector, 'recordMetric');

      const timer = EdgeRum.time('image_upload');
      await new Promise((r) => setTimeout(r, 5));
      timer.end({ file_size_kb: 2048 });

      expect(spy).toHaveBeenCalledTimes(1);
      const [name, value, attrs] = spy.mock.calls[0]!;
      expect(name).toBe('image_upload');
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThanOrEqual(0);
      expect(attrs!['metric.unit']).toBe('ms');
      expect(attrs!['file_size_kb']).toBe(2048);
    });

    it('does nothing when disabled before end()', () => {
      EdgeRum.init(config);
      const timer = EdgeRum.time('x');
      EdgeRum.disable();
      const collector = __getCollector()!;
      const spy = vi.spyOn(collector, 'recordMetric');

      timer.end();

      expect(spy).not.toHaveBeenCalled();
    });

    it('caller attributes override default metric.unit if supplied', () => {
      EdgeRum.init(config);
      const collector = __getCollector()!;
      const spy = vi.spyOn(collector, 'recordMetric');

      EdgeRum.time('disk_io').end({ 'metric.unit': 'bytes' });

      const [, , attrs] = spy.mock.calls[0]!;
      expect(attrs!['metric.unit']).toBe('bytes');
    });
  });

  describe('__subscribeToCurrentRoute', () => {
    it('notifies listeners on each __setCurrentRoute call', () => {
      EdgeRum.init(config);
      const log: string[] = [];
      __subscribeToCurrentRoute((r) => log.push(r));

      __setCurrentRoute('/home');
      __setCurrentRoute('/profile');
      __setCurrentRoute('/profile'); // same — still notifies (no dedup at the source)

      expect(log).toEqual(['/home', '/profile', '/profile']);
    });

    it('returns a dispose function that stops further notifications', () => {
      EdgeRum.init(config);
      const log: string[] = [];
      const unsub = __subscribeToCurrentRoute((r) => log.push(r));

      __setCurrentRoute('/home');
      unsub();
      __setCurrentRoute('/profile');

      expect(log).toEqual(['/home']);
    });

    it('a throwing listener does not block other listeners', () => {
      EdgeRum.init(config);
      const log: string[] = [];
      __subscribeToCurrentRoute(() => {
        throw new Error('listener-broken');
      });
      __subscribeToCurrentRoute((r) => log.push(r));

      expect(() => __setCurrentRoute('/x')).not.toThrow();
      expect(log).toEqual(['/x']);
    });

    it('getCurrentRoute reads the latest set value', () => {
      EdgeRum.init(config);
      __setCurrentRoute('/checkout');
      expect(__getCurrentRoute()).toBe('/checkout');
    });

    it('__resetEdgeRumForTests clears subscribers', () => {
      EdgeRum.init(config);
      const log: string[] = [];
      __subscribeToCurrentRoute((r) => log.push(r));
      __resetEdgeRumForTests();
      EdgeRum.init(config);
      __setCurrentRoute('/x');
      // Old listener was cleared by reset
      expect(log).toEqual([]);
    });
  });

  describe('breadcrumbs integration', () => {
    it('non-crash events populate the breadcrumb buffer', () => {
      EdgeRum.init(config);
      const initialSize = breadcrumbs.size();

      EdgeRum.track('action-1');
      EdgeRum.track('action-2');
      EdgeRum.trackScreen('Home');

      expect(breadcrumbs.size()).toBe(initialSize + 3);
    });

    it('app.crash events do NOT push their own breadcrumb (no recursion)', () => {
      EdgeRum.init(config);
      const beforeSize = breadcrumbs.size();

      EdgeRum.captureError(new Error('test'));

      // No breadcrumb increment from the crash itself.
      expect(breadcrumbs.size()).toBe(beforeSize);
    });
  });
});

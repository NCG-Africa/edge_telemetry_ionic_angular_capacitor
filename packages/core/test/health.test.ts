import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HealthMonitor, healthMonitor } from '../src/internal/health';

describe('HealthMonitor', () => {
  beforeEach(() => {
    healthMonitor.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    healthMonitor.reset();
  });

  it('starts with zero counts and no scope entries', () => {
    expect(healthMonitor.getErrorCount()).toBe(0);
    expect(healthMonitor.getErrorsByScope()).toEqual({});
  });

  it('increments errorCount and per-scope counts', () => {
    healthMonitor.reportError('vitals.recordMetric', new Error('boom'));
    healthMonitor.reportError('vitals.recordMetric', new Error('boom'));
    healthMonitor.reportError('errors.dispose', new Error('x'));
    expect(healthMonitor.getErrorCount()).toBe(3);
    expect(healthMonitor.getErrorsByScope()).toEqual({
      'vitals.recordMetric': 2,
      'errors.dispose': 1,
    });
  });

  it('logs to console.warn only when debug mode is on', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    healthMonitor.setDebug(false);
    healthMonitor.reportError('scope.a', new Error('a'));
    expect(warn).not.toHaveBeenCalled();
    healthMonitor.setDebug(true);
    healthMonitor.reportError('scope.b', new Error('b'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect((warn.mock.calls[0]![0] as string)).toContain('scope.b');
  });

  it('reset() clears everything, including debug flag', () => {
    healthMonitor.setDebug(true);
    healthMonitor.reportError('x', new Error('y'));
    healthMonitor.reset();
    expect(healthMonitor.getErrorCount()).toBe(0);
    expect(healthMonitor.getErrorsByScope()).toEqual({});
    // debug flag is reset; subsequent reportError should not warn
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    healthMonitor.reportError('post-reset', new Error('z'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('getErrorsByScope returns a defensive copy', () => {
    healthMonitor.reportError('a', new Error('a'));
    const snap = healthMonitor.getErrorsByScope();
    snap['a'] = 999;
    expect(healthMonitor.getErrorsByScope()['a']).toBe(1);
  });

  it('a fresh HealthMonitor is isolated from the singleton', () => {
    healthMonitor.reportError('singleton-only', new Error('x'));
    const fresh = new HealthMonitor();
    expect(fresh.getErrorCount()).toBe(0);
    fresh.reportError('private', new Error('y'));
    expect(healthMonitor.getErrorCount()).toBe(1);
    expect(fresh.getErrorCount()).toBe(1);
  });

  describe('ADR-031 circuit breaker', () => {
    const boom = (): Error => new Error('boom');

    it('disposes the capture at exactly the 5th consecutive throw', () => {
      const dispose = vi.fn();
      const m = new HealthMonitor();
      m.registerCapture('frames', dispose);
      for (let i = 0; i < 4; i++) m.reportError('frames.emit', boom());
      expect(dispose).not.toHaveBeenCalled();
      m.reportError('frames.emit', boom());
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(m.getDisposedCaptures()).toBe('frames');
    });

    it('trips on any scope under the capture (substring before first dot)', () => {
      const dispose = vi.fn();
      const m = new HealthMonitor();
      m.registerCapture('frames', dispose);
      m.reportError('frames.emit', boom());
      m.reportError('frames.longtask.setup', boom());
      m.reportError('frames.disconnect', boom());
      m.reportError('frames.emit', boom());
      m.reportError('frames.cancel', boom());
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('a success between throws resets the consecutive count', () => {
      const dispose = vi.fn();
      const m = new HealthMonitor();
      m.registerCapture('frames', dispose);
      for (let i = 0; i < 4; i++) m.reportError('frames.emit', boom());
      m.reportSuccess('frames.emit');
      for (let i = 0; i < 4; i++) m.reportError('frames.emit', boom());
      expect(dispose).not.toHaveBeenCalled();
      m.reportError('frames.emit', boom());
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('stops counting a disposed capture and dispose is called only once', () => {
      const dispose = vi.fn();
      const m = new HealthMonitor();
      m.registerCapture('frames', dispose);
      for (let i = 0; i < 5; i++) m.reportError('frames.emit', boom());
      expect(dispose).toHaveBeenCalledTimes(1);
      // further throws still tally error_count but never re-dispose
      for (let i = 0; i < 10; i++) m.reportError('frames.emit', boom());
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(m.getErrorCount()).toBe(15);
      expect(m.getDisposedCaptures()).toBe('frames');
    });

    it('swallows a throwing dispose, still marks disposed, never rethrows', () => {
      const dispose = vi.fn(() => {
        throw new Error('teardown blew up');
      });
      const m = new HealthMonitor();
      m.registerCapture('frames', dispose);
      expect(() => {
        for (let i = 0; i < 5; i++) m.reportError('frames.emit', boom());
      }).not.toThrow();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(m.getDisposedCaptures()).toBe('frames');
    });

    it('a reportError for an unregistered capture only tallies — no trip', () => {
      const m = new HealthMonitor();
      for (let i = 0; i < 10; i++) m.reportError('vitals.recordMetric', boom());
      expect(m.getErrorCount()).toBe(10);
      expect(m.getDisposedCaptures()).toBe('');
    });

    it('getDisposedCaptures joins multiple disposed captures', () => {
      const m = new HealthMonitor();
      m.registerCapture('frames', vi.fn());
      m.registerCapture('interactions', vi.fn());
      for (let i = 0; i < 5; i++) m.reportError('frames.emit', boom());
      for (let i = 0; i < 5; i++) m.reportError('interactions.click', boom());
      expect(m.getDisposedCaptures()).toBe('frames,interactions');
    });

    it('reset() clears registered captures, counters and the disposed set', () => {
      const dispose = vi.fn();
      healthMonitor.registerCapture('frames', dispose);
      for (let i = 0; i < 5; i++) healthMonitor.reportError('frames.emit', boom());
      expect(healthMonitor.getDisposedCaptures()).toBe('frames');
      healthMonitor.reset();
      expect(healthMonitor.getDisposedCaptures()).toBe('');
      // capture is no longer registered → throws only tally, never trip
      const disposeAfter = vi.fn();
      for (let i = 0; i < 5; i++) healthMonitor.reportError('frames.emit', boom());
      expect(disposeAfter).not.toHaveBeenCalled();
      expect(healthMonitor.getDisposedCaptures()).toBe('');
    });
  });
});

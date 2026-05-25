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
});

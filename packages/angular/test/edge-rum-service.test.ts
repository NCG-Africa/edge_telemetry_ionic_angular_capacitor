import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EdgeRum } from '@edgemetrics/rum';
import { __resetEdgeRumForTests } from '../../core/src/EdgeRum';

import { EdgeRumService } from '../src/EdgeRumService';

beforeEach(() => {
  __resetEdgeRumForTests();
  EdgeRum.init({ apiKey: 'edge_test_key' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EdgeRumService', () => {
  it('delegates identify() to EdgeRum.identify', () => {
    const spy = vi.spyOn(EdgeRum, 'identify');
    const svc = new EdgeRumService();

    svc.identify({ id: 'user_1' });

    expect(spy).toHaveBeenCalledWith({ id: 'user_1' });
  });

  it('delegates track() to EdgeRum.track', () => {
    const spy = vi.spyOn(EdgeRum, 'track');
    const svc = new EdgeRumService();

    svc.track('checkout_started', { 'event.value': 49.99 });

    expect(spy).toHaveBeenCalledWith('checkout_started', { 'event.value': 49.99 });
  });

  it('delegates time() to EdgeRum.time and returns the timer', () => {
    const timer = { end: vi.fn() };
    const spy = vi.spyOn(EdgeRum, 'time').mockReturnValue(timer);
    const svc = new EdgeRumService();

    const result = svc.time('image_upload');

    expect(spy).toHaveBeenCalledWith('image_upload');
    expect(result).toBe(timer);
  });

  it('delegates captureError() to EdgeRum.captureError', () => {
    const spy = vi.spyOn(EdgeRum, 'captureError');
    const svc = new EdgeRumService();
    const err = new Error('boom');

    svc.captureError(err, { screen: 'Home' });

    expect(spy).toHaveBeenCalledWith(err, { screen: 'Home' });
  });

  it('delegates disable() and enable() to EdgeRum', () => {
    const disableSpy = vi.spyOn(EdgeRum, 'disable');
    const enableSpy = vi.spyOn(EdgeRum, 'enable');
    const svc = new EdgeRumService();

    svc.disable();
    svc.enable();

    expect(disableSpy).toHaveBeenCalledTimes(1);
    expect(enableSpy).toHaveBeenCalledTimes(1);
  });

  it('delegates getSessionId() to EdgeRum.getSessionId', () => {
    const spy = vi.spyOn(EdgeRum, 'getSessionId').mockReturnValue('session_1_abcd1234_web');
    const svc = new EdgeRumService();

    expect(svc.getSessionId()).toBe('session_1_abcd1234_web');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('propagates errors from EdgeRum (error path)', () => {
    __resetEdgeRumForTests();
    const svc = new EdgeRumService();

    expect(() => svc.identify({ id: 'x' })).toThrowError(/init\(\) must be called before identify/);
  });
});

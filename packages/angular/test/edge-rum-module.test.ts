import type { NgZone } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EdgeRum, type EdgeRumOptions } from '@nathanclaire/rum';

import { edgeRumInitializerFactory } from '../src/EdgeRumModule';

const VALID_CONFIG: EdgeRumOptions = {
  apiKey: 'edge_test_key',
  endpoint: 'https://example.com/collector/telemetry',
};

const zone = { runOutsideAngular: <T>(f: () => T): T => f() } as unknown as NgZone;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('edgeRumInitializerFactory', () => {
  it('fails open on a malformed apiKey (C5)', () => {
    const fn = edgeRumInitializerFactory({ apiKey: 'wrong_prefix' }, zone, {} as never, null);
    expect(fn).not.toThrow();
  });

  it('runs init outside the Angular zone with defaultCaptures() unless captures are given (A8, C3)', () => {
    const initSpy = vi.spyOn(EdgeRum, 'init');
    const runOutside = vi.spyOn(zone, 'runOutsideAngular');
    const fn = edgeRumInitializerFactory(VALID_CONFIG, zone, {} as never, null);

    expect(fn.length).toBe(0);
    fn();
    expect(runOutside).toHaveBeenCalledOnce();
    const names = initSpy.mock.calls[0]?.[0]?.captures?.map((c) => c.name);
    expect(names).toEqual(['vitals', 'interactions', 'frames', 'longTasks', 'consoleErrors', 'bridge']);

    edgeRumInitializerFactory({ captures: [] }, zone, {} as never, null)();
    expect(initSpy.mock.calls[1]?.[0]?.captures).toEqual([]);
  });
});

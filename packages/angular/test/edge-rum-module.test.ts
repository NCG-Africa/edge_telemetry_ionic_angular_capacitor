import { APP_INITIALIZER, ErrorHandler } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EdgeRum, type EdgeRumConfig } from '@nathanclaire/rum';
import { __resetEdgeRumForTests } from '../../core/src/EdgeRum';

import {
  EDGE_RUM_CONFIG,
  EdgeRumModule,
  edgeRumInitializerFactory,
  provideEdgeRum,
} from '../src/EdgeRumModule';
import { EdgeRumErrorCapture } from '../src/ErrorCapture';
import { EdgeRumService } from '../src/EdgeRumService';

type ClassProvider = { provide: unknown; useClass: unknown };

function isClassProvider(p: unknown): p is ClassProvider {
  return typeof p === 'object' && p !== null && 'useClass' in p;
}

const VALID_CONFIG: EdgeRumConfig = {
  apiKey: 'edge_test_key',
  endpoint: 'https://example.com/collector/telemetry',
  appName: 'TestApp',
  appVersion: '1.0.0',
};

type ValueProvider = { provide: unknown; useValue: unknown };
type FactoryProvider = {
  provide: unknown;
  useFactory: (...args: unknown[]) => unknown;
  deps?: unknown[];
  multi?: boolean;
};

function isValueProvider(p: unknown): p is ValueProvider {
  return typeof p === 'object' && p !== null && 'useValue' in p;
}

function isFactoryProvider(p: unknown): p is FactoryProvider {
  return typeof p === 'object' && p !== null && 'useFactory' in p;
}

beforeEach(() => {
  __resetEdgeRumForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EdgeRumModule.forRoot', () => {
  it('returns a ModuleWithProviders with EdgeRumModule and a provider array', () => {
    const mwp = EdgeRumModule.forRoot(VALID_CONFIG);

    expect(mwp.ngModule).toBe(EdgeRumModule);
    expect(Array.isArray(mwp.providers)).toBe(true);
    expect(mwp.providers!.length).toBeGreaterThan(0);
  });

  it('registers EdgeRumService as a class provider', () => {
    const providers = EdgeRumModule.forRoot(VALID_CONFIG).providers!;
    expect(providers).toContain(EdgeRumService);
  });

  it('registers EDGE_RUM_CONFIG with the supplied config as useValue', () => {
    const providers = EdgeRumModule.forRoot(VALID_CONFIG).providers!;
    const cfgProvider = providers.find(
      (p) => isValueProvider(p) && p.provide === EDGE_RUM_CONFIG,
    ) as ValueProvider | undefined;

    expect(cfgProvider).toBeDefined();
    expect(cfgProvider!.useValue).toEqual(VALID_CONFIG);
  });

  it('registers EdgeRumErrorCapture as the ErrorHandler class provider', () => {
    const providers = EdgeRumModule.forRoot(VALID_CONFIG).providers!;
    const errProvider = providers.find(
      (p) => isClassProvider(p) && p.provide === ErrorHandler,
    ) as ClassProvider | undefined;

    expect(errProvider).toBeDefined();
    expect(errProvider!.useClass).toBe(EdgeRumErrorCapture);
  });

  it('registers a multi APP_INITIALIZER whose factory calls EdgeRum.init', () => {
    const initSpy = vi.spyOn(EdgeRum, 'init');
    const providers = EdgeRumModule.forRoot(VALID_CONFIG).providers!;
    const appInit = providers.find(
      (p) => isFactoryProvider(p) && p.provide === APP_INITIALIZER,
    ) as FactoryProvider | undefined;

    expect(appInit).toBeDefined();
    expect(appInit!.multi).toBe(true);
    expect(appInit!.deps).toHaveLength(3);
    expect(appInit!.deps![0]).toBe(EDGE_RUM_CONFIG);

    const initializer = appInit!.useFactory(VALID_CONFIG, {} as never, null) as () => void;
    initializer();

    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(initSpy).toHaveBeenCalledWith(VALID_CONFIG);
  });
});

describe('provideEdgeRum', () => {
  it('returns a Provider[] with the same shape as forRoot().providers', () => {
    const fromProvide = provideEdgeRum(VALID_CONFIG);
    const fromModule = EdgeRumModule.forRoot(VALID_CONFIG).providers!;

    expect(fromProvide.length).toBe(fromModule.length);
  });

  it('is wire-compatible with TestBed.configureTestingModule (structural check)', () => {
    const providers = provideEdgeRum(VALID_CONFIG);

    expect(providers).toContain(EdgeRumService);
    expect(
      providers.some((p) => isValueProvider(p) && p.provide === EDGE_RUM_CONFIG),
    ).toBe(true);
    expect(
      providers.some(
        (p) => isFactoryProvider(p) && p.provide === APP_INITIALIZER && p.multi === true,
      ),
    ).toBe(true);
  });

  it('APP_INITIALIZER factory invokes EdgeRum.init with the supplied config', () => {
    const initSpy = vi.spyOn(EdgeRum, 'init');
    const providers = provideEdgeRum(VALID_CONFIG);
    const appInit = providers.find(
      (p) => isFactoryProvider(p) && p.provide === APP_INITIALIZER,
    ) as FactoryProvider;

    const initializer = appInit.useFactory(VALID_CONFIG) as () => void;
    initializer();

    expect(initSpy).toHaveBeenCalledWith(VALID_CONFIG);
  });
});

describe('edgeRumInitializerFactory', () => {
  it('propagates EdgeRum.init errors on invalid config (empty apiKey)', () => {
    const badConfig = { apiKey: '' } as unknown as EdgeRumConfig;
    const fn = edgeRumInitializerFactory(badConfig, {} as never, null);

    expect(fn).toThrowError(/apiKey is required/);
  });

  it('propagates EdgeRum.init errors when apiKey lacks "edge_" prefix', () => {
    const badConfig = { apiKey: 'wrong_prefix' } as unknown as EdgeRumConfig;
    const fn = edgeRumInitializerFactory(badConfig, {} as never, null);

    expect(fn).toThrowError(/must start with "edge_"/);
  });

  it('returns a no-arg function that successfully calls EdgeRum.init on valid config', () => {
    const initSpy = vi.spyOn(EdgeRum, 'init');
    const fn = edgeRumInitializerFactory(VALID_CONFIG, {} as never, null);

    expect(fn.length).toBe(0);
    fn();

    expect(initSpy).toHaveBeenCalledWith(VALID_CONFIG);
  });
});

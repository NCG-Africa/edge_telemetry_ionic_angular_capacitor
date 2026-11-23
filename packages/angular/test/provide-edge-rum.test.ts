import '@angular/compiler'; // JIT for the decorated SDK classes in Node
import {
  APP_INITIALIZER,
  ErrorHandler,
  Injectable,
  Injector,
  NgZone,
  createEnvironmentInjector,
  type EnvironmentInjector,
  type EnvironmentProviders,
  type Provider,
} from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EdgeRum } from '@nathanclaire/rum';

import { EdgeRumModule, provideEdgeRum } from '../src/EdgeRumModule';
import { IonicLifecycleCapture } from '../src/IonicLifecycleCapture';
import { RouterCapture } from '../src/RouterCapture';

const hostCalls: unknown[] = [];

@Injectable()
class HostErrorHandler extends ErrorHandler {
  override handleError(error: unknown): void {
    hostCalls.push(error);
  }
}

const zone = { runOutsideAngular: <T>(f: () => T): T => f() };

function boot(providers: Array<Provider | EnvironmentProviders>): EnvironmentInjector {
  const injector = createEnvironmentInjector(
    [
      { provide: NgZone, useValue: zone },
      ...providers,
      // Covered by their own suites; JIT in Node can't read their constructor metadata.
      { provide: RouterCapture, useValue: {} },
      { provide: IonicLifecycleCapture, useValue: {} },
    ],
    Injector.NULL as EnvironmentInjector,
  );
  for (const init of injector.get(APP_INITIALIZER)) void init();
  return injector;
}

afterEach(() => {
  vi.restoreAllMocks();
  hostCalls.length = 0;
});

describe('provideEdgeRum (C7)', () => {
  it('boots EdgeRum.init with the config from an EnvironmentInjector, and forRoot wraps it', () => {
    const init = vi.spyOn(EdgeRum, 'init').mockImplementation(() => undefined);
    boot([provideEdgeRum({ release: 'a' })]);
    boot([...EdgeRumModule.forRoot({ release: 'b' }).providers!]);
    expect(init.mock.calls.map(([o]) => o?.release)).toEqual(['a', 'b']);
  });
});

describe('ErrorHandler chaining (C7)', () => {
  const host = { provide: ErrorHandler, useClass: HostErrorHandler };

  for (const [order, providers] of [
    ['host after provideEdgeRum', () => [provideEdgeRum(), host]],
    ['host before provideEdgeRum', () => [host, provideEdgeRum()]],
    ['host with EdgeRumModule.forRoot', () => [...EdgeRumModule.forRoot().providers!, host]],
  ] as const) {
    it(`captures the error and still calls the host handler (${order})`, () => {
      const capture = vi.spyOn(EdgeRum, 'captureError').mockImplementation(() => undefined);
      const injector = boot(providers());
      const err = new Error('boom');

      injector.get(ErrorHandler).handleError(err);

      expect(hostCalls).toEqual([err]);
      expect(capture).toHaveBeenCalledOnce();
      expect(capture.mock.calls[0]![0]).toBe(err); // captureError sends app.error (#149)
    });
  }

  it('captures once when the SDK is provided twice', () => {
    const capture = vi.spyOn(EdgeRum, 'captureError').mockImplementation(() => undefined);
    boot([provideEdgeRum(), ...EdgeRumModule.forRoot().providers!, host]).get(ErrorHandler).handleError(new Error('x'));
    expect(capture).toHaveBeenCalledOnce();
    expect(hostCalls).toHaveLength(1);
  });

  it('keeps calling the host handler when capture throws', () => {
    vi.spyOn(EdgeRum, 'captureError').mockImplementation(() => {
      throw new Error('internal');
    });
    const err = new Error('boom');
    boot([provideEdgeRum(), host]).get(ErrorHandler).handleError(err);
    expect(hostCalls).toEqual([err]);
  });
});

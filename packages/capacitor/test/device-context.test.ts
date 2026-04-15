import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getDeviceContext,
  type CapacitorLike,
  type DeviceModuleLike,
} from '../src/DeviceContext';

const realCrypto = webcrypto as unknown as Crypto;

class FakeStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

function nativeCapacitor(): CapacitorLike {
  return { isNativePlatform: () => true };
}

function nonNativeCapacitor(): CapacitorLike {
  return { isNativePlatform: () => false };
}

function mockDevice(partial: Partial<DeviceModuleLike> = {}): DeviceModuleLike {
  return {
    getInfo: async () => ({
      model: 'iPhone 15 Pro',
      platform: 'ios',
      operatingSystem: 'ios',
      osVersion: '17.4',
      manufacturer: 'Apple',
      isVirtual: false,
    }),
    getBatteryInfo: async () => ({ batteryLevel: 0.82, isCharging: false }),
    getId: async () => ({ identifier: 'RAW-DEVICE-UUID-123' }),
    ...partial,
  };
}

describe('getDeviceContext', () => {
  let fixedNow: number;

  beforeEach(() => {
    fixedNow = 1_704_067_200_000;
  });

  it('non-native: falls back without throwing and uses navigator.userAgent', async () => {
    const storage = new FakeStorage();
    const attrs = await getDeviceContext({
      capacitor: nonNativeCapacitor(),
      getWindow: () =>
        ({
          screen: { width: 1440, height: 900 },
          devicePixelRatio: 2,
        }) as unknown as Window & typeof globalThis,
      getNavigator: () =>
        ({
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15',
        }) as Navigator,
      getLocalStorage: () => storage,
      getCrypto: () => realCrypto,
      now: () => fixedNow,
    });

    expect(attrs['device.platform']).toBe('web');
    expect(attrs['device.os']).toBe('ios');
    expect(attrs['device.osVersion']).toBe('17.4');
    expect(attrs['device.manufacturer']).toBe('Apple');
    expect(attrs['device.isVirtual']).toBe(false);
    expect(attrs['device.screenWidth']).toBe(1440);
    expect(attrs['device.screenHeight']).toBe(900);
    expect(attrs['device.pixelRatio']).toBe(2);
    expect(attrs['device.id']).toMatch(/^device_\d+_[0-9a-f]{8}_web$/);
  });

  it('non-native without navigator still returns a valid context', async () => {
    const attrs = await getDeviceContext({
      capacitor: nonNativeCapacitor(),
      getWindow: () => undefined,
      getNavigator: () => undefined,
      getLocalStorage: () => undefined,
      getCrypto: () => realCrypto,
      now: () => fixedNow,
    });
    expect(attrs['device.platform']).toBe('web');
    expect(attrs['device.os']).toBe('unknown');
    expect(attrs['device.id']).toMatch(/^device_\d+_[0-9a-f]{8}_web$/);
  });

  it('non-native: does not throw when capacitor.isNativePlatform throws', async () => {
    const attrs = await getDeviceContext({
      capacitor: {
        isNativePlatform: () => {
          throw new Error('boom');
        },
      },
      getCrypto: () => realCrypto,
      getLocalStorage: () => new FakeStorage(),
      now: () => fixedNow,
    });
    expect(attrs['device.platform']).toBe('web');
  });

  it('native mock: device.model, device.os, device.platform present', async () => {
    const attrs = await getDeviceContext({
      capacitor: nativeCapacitor(),
      loadDevice: async () => mockDevice(),
      getCrypto: () => realCrypto,
      now: () => fixedNow,
    });
    expect(attrs['device.model']).toBe('iPhone 15 Pro');
    expect(attrs['device.os']).toBe('ios');
    expect(attrs['device.platform']).toBe('ios');
    expect(attrs['device.manufacturer']).toBe('Apple');
    expect(attrs['device.osVersion']).toBe('17.4');
    expect(attrs['device.isVirtual']).toBe(false);
  });

  it('device.id matches device_{ts}_{8hex}_{platform} pattern', async () => {
    const attrs = await getDeviceContext({
      capacitor: nativeCapacitor(),
      loadDevice: async () => mockDevice(),
      getCrypto: () => realCrypto,
      now: () => fixedNow,
    });
    expect(attrs['device.id']).toMatch(/^device_\d+_[0-9a-f]{8}_ios$/);
    expect(attrs['device.id']).toBe(`device_${fixedNow}_${(attrs['device.id'] as string).split('_')[2]}_ios`);
  });

  it('device.id derives 8 hex chars from SHA-256 of raw identifier', async () => {
    // SHA-256 of "RAW-DEVICE-UUID-123" — verify first 8 hex chars match
    const raw = 'RAW-DEVICE-UUID-123';
    const enc = new TextEncoder().encode(raw);
    const digest = await realCrypto.subtle.digest('SHA-256', enc);
    const bytes = new Uint8Array(digest);
    let expectedHex = '';
    for (let i = 0; i < 4; i++) expectedHex += bytes[i]!.toString(16).padStart(2, '0');

    const attrs = await getDeviceContext({
      capacitor: nativeCapacitor(),
      loadDevice: async () => mockDevice(),
      getCrypto: () => realCrypto,
      now: () => fixedNow,
    });

    const id = attrs['device.id'] as string;
    expect(id.split('_')[2]).toBe(expectedHex);
  });

  it('raw Device.getId() is never stored or transmitted', async () => {
    const raw = 'SUPER-SECRET-DEVICE-IDENTIFIER-XYZ';
    const storage = new FakeStorage();
    const attrs = await getDeviceContext({
      capacitor: nativeCapacitor(),
      loadDevice: async () => mockDevice({ getId: async () => ({ identifier: raw }) }),
      getCrypto: () => realCrypto,
      getLocalStorage: () => storage,
      now: () => fixedNow,
    });

    const serialised = JSON.stringify(attrs);
    expect(serialised).not.toContain(raw);
    // And nothing in localStorage contains it either
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k) expect(storage.getItem(k)).not.toContain(raw);
    }
  });

  it('device.batteryLevel is a number between 0 and 1 when present', async () => {
    const attrs = await getDeviceContext({
      capacitor: nativeCapacitor(),
      loadDevice: async () =>
        mockDevice({ getBatteryInfo: async () => ({ batteryLevel: 0.5, isCharging: true }) }),
      getCrypto: () => realCrypto,
      now: () => fixedNow,
    });
    expect(attrs['device.batteryLevel']).toBe(0.5);
    expect(attrs['device.batteryCharging']).toBe(true);
  });

  it('device.batteryLevel is absent when out of range', async () => {
    const attrs = await getDeviceContext({
      capacitor: nativeCapacitor(),
      loadDevice: async () =>
        mockDevice({ getBatteryInfo: async () => ({ batteryLevel: 2, isCharging: false }) }),
      getCrypto: () => realCrypto,
      now: () => fixedNow,
    });
    expect(attrs['device.batteryLevel']).toBeUndefined();
    expect(attrs['device.batteryCharging']).toBe(false);
  });

  it('device.batteryLevel is absent when getBatteryInfo throws', async () => {
    const attrs = await getDeviceContext({
      capacitor: nativeCapacitor(),
      loadDevice: async () =>
        mockDevice({
          getBatteryInfo: async () => {
            throw new Error('no battery api');
          },
        }),
      getCrypto: () => realCrypto,
      now: () => fixedNow,
    });
    expect(attrs['device.batteryLevel']).toBeUndefined();
    // Core native info still populated
    expect(attrs['device.platform']).toBe('ios');
  });

  it('returns context even if getInfo throws', async () => {
    const attrs = await getDeviceContext({
      capacitor: nativeCapacitor(),
      loadDevice: async () =>
        mockDevice({
          getInfo: async () => {
            throw new Error('info broken');
          },
        }),
      getCrypto: () => realCrypto,
      now: () => fixedNow,
    });
    // Falls back to a web-suffixed id since platform is unknown
    expect(attrs['device.id']).toMatch(/^device_\d+_[0-9a-f]{8}_web$/);
  });

  it('returns context even if @capacitor/device fails to load', async () => {
    const attrs = await getDeviceContext({
      capacitor: nativeCapacitor(),
      loadDevice: async () => {
        throw new Error('module missing');
      },
      getCrypto: () => realCrypto,
      getLocalStorage: () => new FakeStorage(),
      now: () => fixedNow,
    });
    expect(attrs['device.id']).toMatch(/^device_\d+_[0-9a-f]{8}_web$/);
  });

  it('persists the web device suffix across calls via localStorage', async () => {
    const storage = new FakeStorage();
    const deps = {
      capacitor: nonNativeCapacitor(),
      getLocalStorage: () => storage,
      getCrypto: () => realCrypto,
      getNavigator: () => ({ userAgent: '' }) as Navigator,
      now: () => fixedNow,
    };
    const a = await getDeviceContext(deps);
    const b = await getDeviceContext(deps);
    const suffixA = (a['device.id'] as string).split('_')[2];
    const suffixB = (b['device.id'] as string).split('_')[2];
    expect(suffixA).toBe(suffixB);
    expect(storage.getItem('edge_rum_device_id')).toBe(suffixA);
  });

  it('regenerates suffix if stored value is malformed', async () => {
    const storage = new FakeStorage();
    storage.setItem('edge_rum_device_id', 'not-valid-hex');
    const attrs = await getDeviceContext({
      capacitor: nonNativeCapacitor(),
      getLocalStorage: () => storage,
      getCrypto: () => realCrypto,
      now: () => fixedNow,
    });
    const suffix = (attrs['device.id'] as string).split('_')[2];
    expect(suffix).toMatch(/^[0-9a-f]{8}$/);
    expect(storage.getItem('edge_rum_device_id')).toBe(suffix);
  });

  it('survives localStorage.setItem throwing (quota/private mode)', async () => {
    const storage: Storage = {
      length: 0,
      clear: () => undefined,
      getItem: () => null,
      key: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error('quota');
      },
    };
    const attrs = await getDeviceContext({
      capacitor: nonNativeCapacitor(),
      getLocalStorage: () => storage,
      getCrypto: () => realCrypto,
      now: () => fixedNow,
    });
    expect(attrs['device.id']).toMatch(/^device_\d+_[0-9a-f]{8}_web$/);
  });

  it('all attribute values are primitives (string | number | boolean) — no nested objects', async () => {
    const attrs = await getDeviceContext({
      capacitor: nativeCapacitor(),
      loadDevice: async () => mockDevice(),
      getWindow: () =>
        ({ screen: { width: 390, height: 844 }, devicePixelRatio: 3 }) as unknown as Window &
          typeof globalThis,
      getCrypto: () => realCrypto,
      now: () => fixedNow,
    });
    for (const v of Object.values(attrs)) {
      expect(['string', 'number', 'boolean']).toContain(typeof v);
      expect(Array.isArray(v)).toBe(false);
    }
  });

  it('emitted payload contains no OTel identifiers', async () => {
    const attrs = await getDeviceContext({
      capacitor: nativeCapacitor(),
      loadDevice: async () => mockDevice(),
      getCrypto: () => realCrypto,
      now: () => fixedNow,
    });
    const json = JSON.stringify(attrs);
    expect(json).not.toMatch(/traceId/i);
    expect(json).not.toMatch(/spanId/i);
    expect(json).not.toMatch(/resourceSpans/i);
    expect(json).not.toMatch(/instrumentationScope/i);
    expect(json).not.toMatch(/opentelemetry/i);
  });

  it('parses an Android user agent', async () => {
    const attrs = await getDeviceContext({
      capacitor: nonNativeCapacitor(),
      getNavigator: () =>
        ({
          userAgent:
            'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 Chrome/120.0',
        }) as Navigator,
      getLocalStorage: () => new FakeStorage(),
      getCrypto: () => realCrypto,
      now: () => fixedNow,
    });
    expect(attrs['device.os']).toBe('android');
    expect(attrs['device.osVersion']).toBe('14');
    expect(attrs['device.model']).toBe('Pixel 8 Pro');
  });

  it('generates a random 8-hex suffix when crypto.subtle is absent and no storage', async () => {
    // Make subtle unavailable by providing a crypto with only getRandomValues
    const partialCrypto = {
      getRandomValues: <T extends ArrayBufferView | null>(arr: T): T => {
        if (arr instanceof Uint8Array) {
          for (let i = 0; i < arr.length; i++) arr[i] = 0xab;
        }
        return arr;
      },
    } as unknown as Crypto;
    const spy = vi.spyOn(Math, 'random');
    const attrs = await getDeviceContext({
      capacitor: nonNativeCapacitor(),
      getNavigator: () => ({ userAgent: '' }) as Navigator,
      getLocalStorage: () => undefined,
      getCrypto: () => partialCrypto,
      now: () => fixedNow,
    });
    expect(attrs['device.id']).toMatch(/^device_\d+_[0-9a-f]{8}_web$/);
    spy.mockRestore();
  });
});

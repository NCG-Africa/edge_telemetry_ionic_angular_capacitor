export type DevicePlatform = 'ios' | 'android' | 'web';

export type DeviceContextAttributes = Record<string, string | number | boolean>;

export interface CapacitorLike {
  isNativePlatform: () => boolean;
}

export interface DeviceInfoLike {
  model: string;
  platform: DevicePlatform;
  operatingSystem: string;
  osVersion: string;
  manufacturer: string;
  isVirtual: boolean;
}

export interface BatteryInfoLike {
  batteryLevel?: number;
  isCharging?: boolean;
}

export interface DeviceIdLike {
  identifier: string;
}

export interface DeviceModuleLike {
  getInfo: () => Promise<DeviceInfoLike>;
  getBatteryInfo: () => Promise<BatteryInfoLike>;
  getId: () => Promise<DeviceIdLike>;
}

export interface DeviceContextDeps {
  capacitor?: CapacitorLike;
  loadDevice?: () => Promise<DeviceModuleLike>;
  getWindow?: () => (Window & typeof globalThis) | undefined;
  getNavigator?: () => Navigator | undefined;
  getLocalStorage?: () => Storage | undefined;
  getCrypto?: () => Crypto | undefined;
  now?: () => number;
  randomHex8?: () => string;
}

const DEVICE_ID_STORAGE_KEY = 'edge_rum_device_id';

function defaultCapacitor(): CapacitorLike {
  const g = globalThis as unknown as { Capacitor?: CapacitorLike };
  if (g.Capacitor && typeof g.Capacitor.isNativePlatform === 'function') {
    return g.Capacitor;
  }
  return { isNativePlatform: () => false };
}

function defaultLoadDevice(): () => Promise<DeviceModuleLike> {
  return async () => {
    const mod = (await import('@capacitor/device')) as unknown as { Device: DeviceModuleLike };
    return mod.Device;
  };
}

function defaultWindow(): (Window & typeof globalThis) | undefined {
  return typeof window !== 'undefined' ? window : undefined;
}

function defaultNavigator(): Navigator | undefined {
  return typeof navigator !== 'undefined' ? navigator : undefined;
}

function defaultLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

function defaultCrypto(): Crypto | undefined {
  const g = globalThis as unknown as { crypto?: Crypto };
  return g.crypto;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    s += b.toString(16).padStart(2, '0');
  }
  return s;
}

function randomHex8Default(cryptoApi: Crypto | undefined): string {
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    const arr = new Uint8Array(4);
    cryptoApi.getRandomValues(arr);
    return toHex(arr.buffer);
  }
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
    .slice(0, 8);
}

async function sha256Hex8(input: string, cryptoApi: Crypto | undefined): Promise<string | undefined> {
  if (!cryptoApi || !cryptoApi.subtle || typeof cryptoApi.subtle.digest !== 'function') {
    return undefined;
  }
  try {
    const enc = new TextEncoder().encode(input);
    const buf = await cryptoApi.subtle.digest('SHA-256', enc);
    return toHex(buf).slice(0, 8);
  } catch {
    return undefined;
  }
}

function parseUserAgent(
  ua: string | undefined,
): { os: string; osVersion: string; model: string; manufacturer: string } {
  const out = { os: 'unknown', osVersion: '', model: 'unknown', manufacturer: 'unknown' };
  if (!ua) return out;

  const iOSMatch = ua.match(/(iPhone|iPad|iPod).*?OS (\d+[_.\d]*)/);
  if (iOSMatch) {
    out.os = 'ios';
    out.osVersion = (iOSMatch[2] ?? '').replace(/_/g, '.');
    out.model = iOSMatch[1] ?? 'unknown';
    out.manufacturer = 'Apple';
    return out;
  }

  const androidMatch = ua.match(/Android (\d+[.\d]*)(?:;\s*([^;)]+))?/);
  if (androidMatch) {
    out.os = 'android';
    out.osVersion = androidMatch[1] ?? '';
    const model = (androidMatch[2] ?? '').trim();
    if (model) out.model = model;
    return out;
  }

  const macMatch = ua.match(/Mac OS X (\d+[_.\d]*)/);
  if (macMatch) {
    out.os = 'mac';
    out.osVersion = (macMatch[1] ?? '').replace(/_/g, '.');
    out.manufacturer = 'Apple';
    return out;
  }

  const winMatch = ua.match(/Windows NT (\d+[.\d]*)/);
  if (winMatch) {
    out.os = 'windows';
    out.osVersion = winMatch[1] ?? '';
    out.manufacturer = 'Microsoft';
    return out;
  }

  const linuxMatch = ua.match(/Linux/);
  if (linuxMatch) {
    out.os = 'linux';
  }
  return out;
}

const DEVICE_ID_PATTERN = /^device_\d+_[0-9a-f]{8}_.+$/;

function getOrCreateDeviceId(
  storage: Storage | undefined,
  generate: () => string,
): string {
  if (!storage) return generate();
  try {
    const existing = storage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing && DEVICE_ID_PATTERN.test(existing)) return existing;
    const fresh = generate();
    try {
      storage.setItem(DEVICE_ID_STORAGE_KEY, fresh);
    } catch {
      // ignore write failures (private mode, quota)
    }
    return fresh;
  } catch {
    return generate();
  }
}

function addScreenAttributes(
  attrs: DeviceContextAttributes,
  win: (Window & typeof globalThis) | undefined,
): void {
  if (!win) return;
  const screen = (win as unknown as { screen?: { width?: number; height?: number } }).screen;
  if (screen && typeof screen.width === 'number') {
    attrs['device.screenWidth'] = screen.width;
  }
  if (screen && typeof screen.height === 'number') {
    attrs['device.screenHeight'] = screen.height;
  }
  const dpr = (win as unknown as { devicePixelRatio?: number }).devicePixelRatio;
  if (typeof dpr === 'number') {
    attrs['device.pixelRatio'] = dpr;
  }
}

function addBatteryAttributes(attrs: DeviceContextAttributes, battery: BatteryInfoLike): void {
  if (
    typeof battery.batteryLevel === 'number' &&
    Number.isFinite(battery.batteryLevel) &&
    battery.batteryLevel >= 0 &&
    battery.batteryLevel <= 1
  ) {
    attrs['device.batteryLevel'] = battery.batteryLevel;
  }
  if (typeof battery.isCharging === 'boolean') {
    attrs['device.batteryCharging'] = battery.isCharging;
  }
}

export async function getDeviceContext(
  deps: DeviceContextDeps = {},
): Promise<DeviceContextAttributes> {
  const capacitor = deps.capacitor ?? defaultCapacitor();
  const win = deps.getWindow ? deps.getWindow() : defaultWindow();
  const nav = deps.getNavigator ? deps.getNavigator() : defaultNavigator();
  const storage = deps.getLocalStorage ? deps.getLocalStorage() : defaultLocalStorage();
  const cryptoApi = deps.getCrypto ? deps.getCrypto() : defaultCrypto();
  const now = deps.now ?? (() => Date.now());
  const randomHex8 = deps.randomHex8 ?? (() => randomHex8Default(cryptoApi));
  const loadDevice = deps.loadDevice ?? defaultLoadDevice();

  const attrs: DeviceContextAttributes = {};
  let platform: DevicePlatform = 'web';

  const isNative = (() => {
    try {
      return capacitor.isNativePlatform();
    } catch {
      return false;
    }
  })();

  if (isNative) {
    try {
      const device = await loadDevice();
      try {
        const info = await device.getInfo();
        platform = info.platform;
        attrs['device.platform'] = info.platform;
        attrs['device.model'] = info.model;
        attrs['device.manufacturer'] = info.manufacturer;
        attrs['device.os'] = info.operatingSystem;
        attrs['device.osVersion'] = info.osVersion;
        attrs['device.isVirtual'] = info.isVirtual;
      } catch {
        // leave defaults; fall through
      }

      try {
        const battery = await device.getBatteryInfo();
        addBatteryAttributes(attrs, battery);
      } catch {
        // battery is optional
      }

      try {
        const raw = await device.getId();
        const hex8 = await sha256Hex8(raw.identifier, cryptoApi);
        if (hex8) {
          attrs['device.id'] = getOrCreateDeviceId(storage, () => `device_${now()}_${hex8}_${platform}`);
        }
      } catch {
        // fall through to fallback id below
      }
    } catch {
      // @capacitor/device failed to load — fall back as if non-native
    }
  } else {
    const parsed = parseUserAgent(nav?.userAgent);
    attrs['device.platform'] = 'web';
    attrs['device.model'] = parsed.model;
    attrs['device.manufacturer'] = parsed.manufacturer;
    attrs['device.os'] = parsed.os;
    attrs['device.osVersion'] = parsed.osVersion;
    attrs['device.isVirtual'] = false;
  }

  if (!('device.id' in attrs)) {
    attrs['device.id'] = getOrCreateDeviceId(storage, () => `device_${now()}_${randomHex8()}_${platform}`);
  }

  addScreenAttributes(attrs, win);

  return attrs;
}

export const __internal = {
  DEVICE_ID_STORAGE_KEY,
  parseUserAgent,
  sha256Hex8,
  toHex,
};

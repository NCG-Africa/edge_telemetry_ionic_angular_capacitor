export type IdPrefix = 'session' | 'user' | 'device';

const ANONYMOUS_USER_ID_KEY = 'edge_rum_anon_uid';

export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function randomHex8(): string {
  if (
    typeof globalThis !== 'undefined' &&
    'crypto' in globalThis &&
    typeof (globalThis as unknown as { crypto: Crypto }).crypto.getRandomValues === 'function'
  ) {
    const arr = new Uint8Array(4);
    (globalThis as unknown as { crypto: Crypto }).crypto.getRandomValues(arr);
    let s = '';
    for (let i = 0; i < arr.length; i++) {
      const b = arr[i] ?? 0;
      s += b.toString(16).padStart(2, '0');
    }
    return s;
  }
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
    .slice(0, 8);
}

export function generateSessionId(platform: string): string {
  return `session_${Date.now()}_${randomHex8()}_${platform}`;
}

export function generateUserId(): string {
  return `user_${Date.now()}_${randomHex8()}`;
}

function defaultLocalStorage(): StorageLike | undefined {
  if (typeof globalThis === 'undefined') return undefined;
  const ls = (globalThis as unknown as { localStorage?: StorageLike }).localStorage;
  return ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function' ? ls : undefined;
}

export function getOrCreateAnonymousUserId(storage?: StorageLike): string {
  const store = storage ?? defaultLocalStorage();
  if (!store) {
    return generateUserId();
  }
  try {
    const existing = store.getItem(ANONYMOUS_USER_ID_KEY);
    if (existing && existing.startsWith('user_')) {
      return existing;
    }
    const fresh = generateUserId();
    store.setItem(ANONYMOUS_USER_ID_KEY, fresh);
    return fresh;
  } catch {
    return generateUserId();
  }
}

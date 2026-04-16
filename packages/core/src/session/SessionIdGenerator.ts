export type IdPrefix = 'session' | 'user' | 'device';

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

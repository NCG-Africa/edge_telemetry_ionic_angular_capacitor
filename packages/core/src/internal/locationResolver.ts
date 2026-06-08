import { healthMonitor } from './health';

export const DEFAULT_LOCATION_PROVIDER_URL = 'https://ipapi.co/json/';
const CACHE_KEY = 'edge_rum_location';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

interface ResolveOptions {
  url?: string;
  debug?: boolean;
  fetchFn?: typeof fetch;
  now?: () => number;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

function getStorage(override?: ResolveOptions['storage']): ResolveOptions['storage'] {
  if (override !== undefined) return override;
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Accessing localStorage can throw in sandboxed iframes / private mode.
  }
  return null;
}

function readCache(storage: ResolveOptions['storage'], now: number): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CacheEntry>;
    if (typeof parsed.value !== 'string' || typeof parsed.expiresAt !== 'number') return null;
    if (parsed.expiresAt < now) {
      try { storage.removeItem(CACHE_KEY); } catch { /* ignore */ }
      return null;
    }
    return parsed.value;
  } catch {
    return null;
  }
}

function writeCache(storage: ResolveOptions['storage'], value: string, expiresAt: number): void {
  if (!storage) return;
  try {
    storage.setItem(CACHE_KEY, JSON.stringify({ value, expiresAt } satisfies CacheEntry));
  } catch {
    // Quota or disabled storage — not fatal, we'll re-resolve next launch.
  }
}

// Accepts the two common free-provider shapes:
//   ipapi.co  → { city, country_name }
//   ipinfo.io → { city, country }   (country is ISO-2 there, still useful)
// Falls back through them so consumers can swap providers without a custom mapper.
export function parseProviderResponse(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  const city = typeof obj.city === 'string' ? obj.city.trim() : '';
  const countryName = typeof obj.country_name === 'string' ? obj.country_name.trim() : '';
  const country = typeof obj.country === 'string' ? obj.country.trim() : '';
  const resolvedCountry = countryName || country;
  if (!city && !resolvedCountry) return null;
  if (!city) return resolvedCountry;
  if (!resolvedCountry) return city;
  return `${city}/${resolvedCountry}`;
}

export async function resolveLocation(options: ResolveOptions = {}): Promise<string | null> {
  const url = options.url ?? DEFAULT_LOCATION_PROVIDER_URL;
  const now = (options.now ?? Date.now)();
  const storage = getStorage(options.storage);

  const cached = readCache(storage, now);
  if (cached !== null) return cached;

  const fetchFn = options.fetchFn ?? (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchFn) return null;

  try {
    const response = await fetchFn(url, { method: 'GET' });
    if (!response.ok) {
      if (options.debug) {
        // eslint-disable-next-line no-console
        console.warn('[edge-rum] location resolver: non-ok status', response.status);
      }
      return null;
    }
    const json = await response.json();
    const value = parseProviderResponse(json);
    if (value === null) return null;
    writeCache(storage, value, now + CACHE_TTL_MS);
    return value;
  } catch (err) {
    healthMonitor.reportError('location.resolve', err);
    if (options.debug) {
      // eslint-disable-next-line no-console
      console.warn('[edge-rum] location resolver failed', err);
    }
    return null;
  }
}

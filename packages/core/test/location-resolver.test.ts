import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LOCATION_PROVIDER_URL,
  parseProviderResponse,
  resolveLocation,
} from '../src/internal/locationResolver';
import { healthMonitor } from '../src/internal/health';

const CACHE_KEY = 'edge_rum_location';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface FakeStorage {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
  raw: Map<string, string>;
}

function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const raw = new Map(Object.entries(initial));
  return {
    raw,
    getItem: (k) => raw.get(k) ?? null,
    setItem: (k, v) => { raw.set(k, v); },
    removeItem: (k) => { raw.delete(k); },
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe('parseProviderResponse', () => {
  it('builds "City/Country" from ipapi.co shape', () => {
    expect(parseProviderResponse({ city: 'Nairobi', country_name: 'Kenya' })).toBe('Nairobi/Kenya');
  });

  it('falls back to ipinfo.io country field when country_name is absent', () => {
    expect(parseProviderResponse({ city: 'Berlin', country: 'DE' })).toBe('Berlin/DE');
  });

  it('prefers country_name over country when both present', () => {
    expect(parseProviderResponse({ city: 'Paris', country_name: 'France', country: 'FR' }))
      .toBe('Paris/France');
  });

  it('returns just the country when city is missing', () => {
    expect(parseProviderResponse({ country_name: 'Kenya' })).toBe('Kenya');
  });

  it('returns just the city when country is missing', () => {
    expect(parseProviderResponse({ city: 'Nairobi' })).toBe('Nairobi');
  });

  it('trims whitespace from city and country', () => {
    expect(parseProviderResponse({ city: '  Nairobi  ', country_name: '  Kenya  ' }))
      .toBe('Nairobi/Kenya');
  });

  it('returns null when both fields are missing', () => {
    expect(parseProviderResponse({})).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseProviderResponse(null)).toBeNull();
    expect(parseProviderResponse('Nairobi')).toBeNull();
    expect(parseProviderResponse(42)).toBeNull();
  });

  it('ignores non-string field values', () => {
    expect(parseProviderResponse({ city: 123, country_name: ['Kenya'] })).toBeNull();
  });

  it('treats empty strings as missing', () => {
    expect(parseProviderResponse({ city: '', country_name: '' })).toBeNull();
    expect(parseProviderResponse({ city: '   ', country_name: '   ' })).toBeNull();
  });
});

describe('resolveLocation', () => {
  beforeEach(() => {
    healthMonitor.reset();
  });

  it('fetches the default provider URL when none is given', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ city: 'Nairobi', country_name: 'Kenya' }));
    await resolveLocation({ fetchFn, storage: fakeStorage(), now: () => 1000 });
    expect(fetchFn).toHaveBeenCalledWith(DEFAULT_LOCATION_PROVIDER_URL, { method: 'GET' });
  });

  it('fetches the configured provider URL', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ city: 'Berlin', country: 'DE' }));
    await resolveLocation({
      url: 'https://ipinfo.io/json',
      fetchFn,
      storage: fakeStorage(),
      now: () => 1000,
    });
    expect(fetchFn).toHaveBeenCalledWith('https://ipinfo.io/json', { method: 'GET' });
  });

  it('returns the parsed "City/Country" string on success', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ city: 'Nairobi', country_name: 'Kenya' }));
    const result = await resolveLocation({ fetchFn, storage: fakeStorage(), now: () => 1000 });
    expect(result).toBe('Nairobi/Kenya');
  });

  it('writes a cache entry with the configured TTL on success', async () => {
    const storage = fakeStorage();
    const fetchFn = vi.fn(async () => jsonResponse({ city: 'Nairobi', country_name: 'Kenya' }));
    await resolveLocation({ fetchFn, storage, now: () => 1000 });
    const cached = JSON.parse(storage.raw.get(CACHE_KEY) ?? '{}');
    expect(cached.value).toBe('Nairobi/Kenya');
    expect(cached.expiresAt).toBe(1000 + CACHE_TTL_MS);
  });

  it('serves from cache without calling fetch', async () => {
    const storage = fakeStorage({
      [CACHE_KEY]: JSON.stringify({ value: 'Nairobi/Kenya', expiresAt: 5000 }),
    });
    const fetchFn = vi.fn();
    const result = await resolveLocation({ fetchFn, storage, now: () => 1000 });
    expect(result).toBe('Nairobi/Kenya');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('ignores expired cache entries and re-fetches', async () => {
    const storage = fakeStorage({
      [CACHE_KEY]: JSON.stringify({ value: 'Stale/Place', expiresAt: 500 }),
    });
    const fetchFn = vi.fn(async () => jsonResponse({ city: 'Nairobi', country_name: 'Kenya' }));
    const result = await resolveLocation({ fetchFn, storage, now: () => 1000 });
    expect(result).toBe('Nairobi/Kenya');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('removes expired cache entries', async () => {
    const storage = fakeStorage({
      [CACHE_KEY]: JSON.stringify({ value: 'Stale/Place', expiresAt: 500 }),
    });
    const fetchFn = vi.fn(async () => jsonResponse({ city: 'Nairobi', country_name: 'Kenya' }));
    await resolveLocation({ fetchFn, storage, now: () => 1000 });
    // It writes the fresh entry — the important thing is the stale one is gone.
    const after = JSON.parse(storage.raw.get(CACHE_KEY) ?? '{}');
    expect(after.value).toBe('Nairobi/Kenya');
  });

  it('returns null and does not cache on non-ok HTTP response', async () => {
    const storage = fakeStorage();
    const fetchFn = vi.fn(async () => jsonResponse({}, false, 500));
    const result = await resolveLocation({ fetchFn, storage, now: () => 1000 });
    expect(result).toBeNull();
    expect(storage.raw.has(CACHE_KEY)).toBe(false);
  });

  it('returns null when provider returns unparseable JSON shape', async () => {
    const storage = fakeStorage();
    const fetchFn = vi.fn(async () => jsonResponse({ irrelevant: true }));
    const result = await resolveLocation({ fetchFn, storage, now: () => 1000 });
    expect(result).toBeNull();
    expect(storage.raw.has(CACHE_KEY)).toBe(false);
  });

  it('returns null and reports to healthMonitor on fetch throw', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('offline'); });
    const result = await resolveLocation({ fetchFn, storage: fakeStorage(), now: () => 1000 });
    expect(result).toBeNull();
    expect(healthMonitor.getErrorCount()).toBeGreaterThanOrEqual(1);
  });

  it('returns null when global fetch is unavailable and no override provided', async () => {
    const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    delete (globalThis as { fetch?: typeof fetch }).fetch;
    try {
      const result = await resolveLocation({ storage: fakeStorage(), now: () => 1000 });
      expect(result).toBeNull();
    } finally {
      (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    }
  });

  it('survives malformed cache JSON by re-fetching', async () => {
    const storage = fakeStorage({ [CACHE_KEY]: '{not-json' });
    const fetchFn = vi.fn(async () => jsonResponse({ city: 'Nairobi', country_name: 'Kenya' }));
    const result = await resolveLocation({ fetchFn, storage, now: () => 1000 });
    expect(result).toBe('Nairobi/Kenya');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('ignores cache entries with the wrong shape', async () => {
    const storage = fakeStorage({
      [CACHE_KEY]: JSON.stringify({ value: 42, expiresAt: 'soon' }),
    });
    const fetchFn = vi.fn(async () => jsonResponse({ city: 'Nairobi', country_name: 'Kenya' }));
    const result = await resolveLocation({ fetchFn, storage, now: () => 1000 });
    expect(result).toBe('Nairobi/Kenya');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('does not throw when storage is null', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ city: 'Nairobi', country_name: 'Kenya' }));
    const result = await resolveLocation({ fetchFn, storage: null, now: () => 1000 });
    expect(result).toBe('Nairobi/Kenya');
  });

  it('does not throw when storage.setItem throws (quota / disabled)', async () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => {},
    };
    const fetchFn = vi.fn(async () => jsonResponse({ city: 'Nairobi', country_name: 'Kenya' }));
    const result = await resolveLocation({ fetchFn, storage, now: () => 1000 });
    expect(result).toBe('Nairobi/Kenya');
  });
});

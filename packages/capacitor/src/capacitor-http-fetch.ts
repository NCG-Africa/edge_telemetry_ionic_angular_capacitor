import type { FetchLike } from '@nathanclaire/rum';

export interface CapacitorLike {
  isNativePlatform: () => boolean;
}

export interface CapacitorHttpRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  data?: string;
}

export interface CapacitorHttpResponseLike {
  data: unknown;
  status: number;
  headers: Record<string, string>;
  url: string;
}

export interface CapacitorHttpLike {
  request: (options: CapacitorHttpRequestOptions) => Promise<CapacitorHttpResponseLike>;
}

export interface CapacitorHttpFetchDeps {
  loadCapacitorHttp?: () => Promise<CapacitorHttpLike>;
}

function defaultLoadCapacitorHttp(): () => Promise<CapacitorHttpLike> {
  return async () => {
    const mod = (await import('@capacitor/core')) as unknown as { CapacitorHttp: CapacitorHttpLike };
    const plugin = mod.CapacitorHttp;
    return {
      request: (options) => plugin.request(options),
    };
  };
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const [key, value] of headers) {
      out[key] = value;
    }
    return out;
  }
  return { ...(headers as Record<string, string>) };
}

function wrapResponse(res: CapacitorHttpResponseLike): Response {
  const lowercased: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    lowercased[k.toLowerCase()] = v;
  }
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    headers: {
      get(name: string): string | null {
        return lowercased[name.toLowerCase()] ?? null;
      },
    } as Headers,
  } as Response;
}

export function createCapacitorHttpFetch(deps: CapacitorHttpFetchDeps = {}): FetchLike {
  const load = deps.loadCapacitorHttp ?? defaultLoadCapacitorHttp();
  let cached: CapacitorHttpLike | null = null;

  return async (input: string, init?: RequestInit): Promise<Response> => {
    if (!cached) {
      cached = await load();
    }
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const res = await cached.request({
      url: input,
      method: init?.method ?? 'GET',
      headers: normalizeHeaders(init?.headers),
      data: body,
    });
    return wrapResponse(res);
  };
}

import { composeSanitizeUrl } from './url-sanitizer';

export type HttpRequestAttributes = {
  'http.url': string;
  'http.method': string;
  'http.status_code': number;
  'http.duration_ms': number;
  'http.success': boolean;
  'http.timestamp': string;
};

export interface RequestsDeps {
  recordEvent: (eventName: 'http.request', attributes: HttpRequestAttributes) => void;
  ignoreUrls?: (string | RegExp)[];
  sanitizeUrl?: (url: string) => string;
  target?: typeof globalThis;
}

export interface RequestsHandle {
  dispose: () => void;
}

function shouldIgnore(url: string, patterns: (string | RegExp)[]): boolean {
  for (const pattern of patterns) {
    if (typeof pattern === 'string') {
      if (url.includes(pattern)) return true;
    } else {
      if (pattern.test(url)) return true;
    }
  }
  return false;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 400;
}

export function registerRequestCapture(deps: RequestsDeps): RequestsHandle {
  const target = deps.target ?? (typeof globalThis !== 'undefined' ? globalThis : undefined);
  if (!target || typeof target.fetch !== 'function') {
    return { dispose: () => undefined };
  }

  const originalFetch = target.fetch.bind(target);
  const ignoreUrls = deps.ignoreUrls ?? [];
  const sanitizeUrl = composeSanitizeUrl(deps.sanitizeUrl);

  const patchedFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;

    if (shouldIgnore(url, ignoreUrls)) {
      return originalFetch(input, init);
    }

    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET');
    const startTime = Date.now();

    let response: Response;
    try {
      response = await originalFetch(input, init);
    } catch (err) {
      try {
        deps.recordEvent('http.request', {
          'http.url': sanitizeUrl(url),
          'http.method': method.toUpperCase(),
          'http.status_code': 0,
          'http.duration_ms': Date.now() - startTime,
          'http.success': false,
          'http.timestamp': new Date().toISOString(),
        });
      } catch {
        // Never let capture errors escape.
      }
      throw err;
    }

    try {
      deps.recordEvent('http.request', {
        'http.url': sanitizeUrl(url),
        'http.method': method.toUpperCase(),
        'http.status_code': response.status,
        'http.duration_ms': Date.now() - startTime,
        'http.success': isSuccess(response.status),
        'http.timestamp': new Date().toISOString(),
      });
    } catch {
      // Never let capture errors escape.
    }

    return response;
  };

  target.fetch = patchedFetch;

  return {
    dispose: () => {
      try {
        if (target.fetch === patchedFetch) {
          target.fetch = originalFetch;
        }
      } catch {
        // ignore
      }
    },
  };
}

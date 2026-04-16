import { composeSanitizeUrl } from './url-sanitizer';

export type NetworkRequestAttributes = {
  'network.url': string;
  'network.method': string;
  'network.status_code': number;
  'network.duration_ms': number;
  'network.request_body_size': number;
  'network.response_body_size': number;
  'network.parent_screen': string;
};

export interface RequestsDeps {
  recordEvent: (eventName: 'network_request', attributes: NetworkRequestAttributes) => void;
  getCurrentRoute: () => string;
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

function estimateBodySize(body: BodyInit | null | undefined): number {
  if (!body) return 0;
  if (typeof body === 'string') return body.length;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (body instanceof Blob) return body.size;
  if (typeof body === 'object' && 'byteLength' in body) {
    return (body as ArrayBufferView).byteLength;
  }
  return 0;
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
    const requestBodySize = estimateBodySize(init?.body);
    const startTime = Date.now();

    let response: Response;
    try {
      response = await originalFetch(input, init);
    } catch (err) {
      try {
        deps.recordEvent('network_request', {
          'network.url': sanitizeUrl(url),
          'network.method': method.toUpperCase(),
          'network.status_code': 0,
          'network.duration_ms': Date.now() - startTime,
          'network.request_body_size': requestBodySize,
          'network.response_body_size': 0,
          'network.parent_screen': deps.getCurrentRoute(),
        });
      } catch {
        // Never let capture errors escape.
      }
      throw err;
    }

    try {
      const contentLength = response.headers.get('content-length');
      const responseBodySize = contentLength ? parseInt(contentLength, 10) || 0 : 0;

      deps.recordEvent('network_request', {
        'network.url': sanitizeUrl(url),
        'network.method': method.toUpperCase(),
        'network.status_code': response.status,
        'network.duration_ms': Date.now() - startTime,
        'network.request_body_size': requestBodySize,
        'network.response_body_size': responseBodySize,
        'network.parent_screen': deps.getCurrentRoute(),
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

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
  if (!target) {
    return { dispose: () => undefined };
  }

  const ignoreUrls = deps.ignoreUrls ?? [];
  const sanitizeUrl = composeSanitizeUrl(deps.sanitizeUrl);

  const record = (url: string, method: string, status: number, startTime: number): void => {
    try {
      deps.recordEvent('http.request', {
        'http.url': sanitizeUrl(url),
        'http.method': method.toUpperCase(),
        'http.status_code': status,
        'http.duration_ms': Date.now() - startTime,
        'http.success': isSuccess(status),
        'http.timestamp': new Date().toISOString(),
      });
    } catch {
      // Never let capture errors escape.
    }
  };

  const disposers: Array<() => void> = [];

  if (typeof target.fetch === 'function') {
    const originalFetch = target.fetch.bind(target);

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
        record(url, method, 0, startTime);
        throw err;
      }
      record(url, method, response.status, startTime);
      return response;
    };

    target.fetch = patchedFetch;
    disposers.push(() => {
      if (target.fetch === patchedFetch) target.fetch = originalFetch;
    });
  }

  // Angular HttpClient uses XHR by default up to Angular 21 (#85).
  const proto = target.XMLHttpRequest?.prototype;
  if (proto) {
    const originalOpen = proto.open;
    const originalSend = proto.send;
    const pending = new WeakMap<XMLHttpRequest, { method: string; url: string }>();

    const patchedOpen = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]): void {
      pending.set(this, { method, url: String(url) });
      (originalOpen as (...args: unknown[]) => void).apply(this, [method, url, ...rest]);
    } as typeof proto.open;

    const patchedSend = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
      const req = pending.get(this);
      if (req && !shouldIgnore(req.url, ignoreUrls)) {
        const startTime = Date.now();
        // status is 0 on network error / abort / timeout, matching fetch rejection.
        this.addEventListener('loadend', () => record(req.url, req.method, this.status, startTime), { once: true });
      }
      originalSend.call(this, body);
    };

    proto.open = patchedOpen;
    proto.send = patchedSend;
    disposers.push(() => {
      if (proto.open === patchedOpen) proto.open = originalOpen;
      if (proto.send === patchedSend) proto.send = originalSend;
    });
  }

  return {
    dispose: () => {
      for (const d of disposers) {
        try {
          d();
        } catch {
          // ignore
        }
      }
    },
  };
}

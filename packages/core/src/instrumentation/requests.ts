import type { EventAttributes } from '../core';
import type { RequestTrace } from '../traces';
import { parseUrl, scrubUrl, unwrapProxyUrl } from './url-sanitizer';

export type HttpRequestAttributes = {
  'http.url': string;
  'http.method': string;
  'http.status_code': number;
  'http.duration_ms': number;
  'http.success': boolean;
  'http.timestamp': string;
  'http.request_size'?: number;
  'http.response_size'?: number;
};

export interface RequestsDeps {
  recordEvent: (eventName: 'http.request', attributes: HttpRequestAttributes & EventAttributes) => void;
  ignoreUrls?: (string | RegExp)[];
  sanitizeUrl?: (url: string) => string;
  /** X3: trace decision at send — the `traceparent` to write and the row's trace keys. */
  trace?: (url: string, consumer: string | null | undefined, noCors: boolean) => RequestTrace | undefined;
  /** E25 dead taps: every send, ignored URLs included, answers a tap. */
  onSend?: () => void;
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

/** Resolved, as XHR's: ignore rules see one form whichever API the app used; proxy unwrapped. */
const resolve = (url: string) => {
  const raw = unwrapProxyUrl(url);
  return parseUrl(raw)?.href ?? raw;
};

const utf8 = (s: string) => new TextEncoder().encode(s).length;

/** E6: request body bytes where knowable without reading a stream; FormData / streams → none. */
function bodySize(body: unknown): number | undefined {
  if (typeof body === 'string') return utf8(body);
  if (body instanceof URLSearchParams) return utf8(body.toString());
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}

/** E6: response bytes from `Content-Length` only; P3 — no other header is read. */
function contentLength(value: string | null | undefined): number | undefined {
  const n = value ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const TRACEPARENT = 'traceparent';

export function registerRequestCapture(deps: RequestsDeps): RequestsHandle {
  const target = deps.target ?? (typeof globalThis !== 'undefined' ? globalThis : undefined);
  if (!target) {
    return { dispose: () => undefined };
  }

  const ignoreUrls = deps.ignoreUrls ?? [];

  const record = (
    url: string, method: string, status: number, startTime: number, trace?: RequestTrace, requestSize?: number, responseSize?: number,
  ): void => {
    try {
      const duration = Math.round(clock() - startTime);
      const attrs: HttpRequestAttributes & EventAttributes = {
        ...trace?.end(duration),
        'http.url': scrubUrl(url, deps.sanitizeUrl),
        'http.method': method.toUpperCase(),
        'http.status_code': status,
        'http.duration_ms': duration,
        'http.success': isSuccess(status),
        'http.timestamp': new Date().toISOString(),
      };
      if (requestSize !== undefined) attrs['http.request_size'] = requestSize;
      if (responseSize !== undefined) attrs['http.response_size'] = responseSize;
      deps.recordEvent('http.request', attrs);
    } catch {
      // Never let capture errors escape.
    }
  };

  const disposers: Array<() => void> = [];

  if (typeof target.fetch === 'function') {
    const originalFetch = target.fetch.bind(target);

    const patchedFetch: typeof fetch = async (input, init) => {
      const req = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
      const url = resolve(req ? req.url : String(input));
      deps.onSend?.();

      if (shouldIgnore(url, ignoreUrls)) {
        return originalFetch(input, init);
      }

      const method = init?.method ?? req?.method ?? 'GET';
      const requestSize = bodySize(init?.body);
      const startTime = clock();
      // `init.headers` replaces the Request's own, as fetch does.
      const headers = init?.headers ?? req?.headers;
      let trace: RequestTrace | undefined;
      try {
        trace = deps.trace?.(url, headers ? new Headers(headers).get(TRACEPARENT) : undefined, (init?.mode ?? req?.mode) === 'no-cors');
        if (trace?.header) {
          // X3: a copy; the consumer's Request / Headers are never mutated. `set` overwrites a malformed one (X5).
          const copy = new Headers(headers);
          copy.set(TRACEPARENT, trace.header);
          init = { ...init, headers: copy };
        }
      } catch {
        // Never let tracing break the request.
      }

      let response: Response;
      try {
        response = await originalFetch(input, init);
      } catch (err) {
        record(url, method, 0, startTime, trace, requestSize);
        throw err;
      }
      record(url, method, response.status, startTime, trace, requestSize, contentLength(response.headers?.get('content-length')));
      return response;
    };

    target.fetch = patchedFetch;
    disposers.push(() => {
      if (target.fetch === patchedFetch) target.fetch = originalFetch;
    });
  }

  // E6: Angular HttpClient uses XHR by default up to Angular 21 — the 4.x gap (#85).
  const proto = target.XMLHttpRequest?.prototype;
  if (proto) {
    const originalOpen = proto.open;
    const originalSend = proto.send;
    const originalSetHeader = proto.setRequestHeader;
    // `tp`: the app's own traceparent, held until send (XHR appends, so it can't be overwritten after).
    const pending = new WeakMap<XMLHttpRequest, { method: string; url: string; tp?: string }>();
    // The send whose `loadend` counts: a reopen or a throwing send leaves an older listener behind.
    const live = new WeakMap<XMLHttpRequest, object>();

    const patchedOpen = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]): void {
      pending.set(this, { method, url: resolve(String(url)) });
      live.delete(this);
      (originalOpen as (...args: unknown[]) => void).apply(this, [method, url, ...rest]);
    } as typeof proto.open;

    const patchedSetHeader = function (this: XMLHttpRequest, name: string, value: string): void {
      const req = pending.get(this);
      if (req && String(name).toLowerCase() === TRACEPARENT) req.tp = String(value);
      else originalSetHeader.call(this, name, value);
    };

    const patchedSend = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
      const req = pending.get(this);
      deps.onSend?.();
      const ignored = !req || shouldIgnore(req.url, ignoreUrls);
      let trace: RequestTrace | undefined;
      try {
        if (!ignored) trace = deps.trace?.(req.url, req.tp, false);
        const tp = trace?.header ?? req?.tp;
        if (tp !== undefined) originalSetHeader.call(this, TRACEPARENT, tp);
      } catch {
        // Never let tracing break the request.
      }
      if (req && !ignored) {
        const requestSize = bodySize(body);
        const startTime = clock();
        const token = {};
        live.set(this, token);
        // status is 0 on network error / abort / timeout, matching fetch rejection.
        this.addEventListener('loadend', () => {
          if (live.get(this) !== token) return;
          live.delete(this);
          let size: number | undefined;
          try {
            size = contentLength(this.getResponseHeader('content-length'));
          } catch {
            // Fakes and odd hosts may lack it.
          }
          record(req.url, req.method, this.status, startTime, trace, requestSize, size);
        }, { once: true });
      }
      originalSend.call(this, body);
    };

    proto.open = patchedOpen;
    proto.send = patchedSend;
    proto.setRequestHeader = patchedSetHeader;
    disposers.push(() => {
      if (proto.setRequestHeader === patchedSetHeader) proto.setRequestHeader = originalSetHeader;
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

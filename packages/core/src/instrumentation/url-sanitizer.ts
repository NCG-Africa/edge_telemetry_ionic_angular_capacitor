// P2: the one templater for `http.url`, resource-timing hosts and (#119) `traceparent` host matching.

const PROXY = /\/_capacitor_https?_interceptor_\/?\?(?:[^#]*&)?u=([^&#]*)/;
// No case folding: `V2` → `{id}`, as the processor does.
const VERSION = /^v\d+$/;
const MAX_DEPTH = 6;

/** A CapacitorHttp proxy URL (`/_capacitor_http_interceptor_?u=…`), which is the bridge, not the app. */
export const isProxyUrl = (url: string): boolean => PROXY.test(url);

/** CapacitorHttp proxy URLs carry the real one in `u`; anything else is returned as is. */
export function unwrapProxyUrl(url: string): string {
  const m = PROXY.exec(url);
  if (!m?.[1]) return url;
  try {
    // Built with `searchParams.append`, so a space arrives as `+`.
    return decodeURIComponent(m[1].replace(/\+/g, ' '));
  } catch {
    return url;
  }
}

/** `vN` kept; a segment holding a digit, or ≥ 32 chars, → `{id}` (RN contract §4.4.1). */
const segment = (s: string) => (!VERSION.test(s) && (/\d/.test(s) || s.length >= 32) ? '{id}' : s);

/** Templated path: empty → `/`, trailing slash dropped, depth capped at 6 then `/…`. */
function templatePath(path: string): string {
  const parts = path.split('/').filter((s) => s !== '');
  if (parts.length === 0) return '/';
  return `/${parts.slice(0, MAX_DEPTH).map(segment).join('/')}${parts.length > MAX_DEPTH ? '/…' : ''}`;
}

/** Parsed against the page, so a relative URL gets the app's own origin. */
export function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url, typeof location !== 'undefined' ? location.href : undefined);
  } catch {
    return undefined;
  }
}

/**
 * P2 / RN contract §4.4.1: proxy unwrapped, then `host[:port]` + templated path; scheme, query,
 * fragment and userinfo dropped. The shape the processor stores in `rum_http_requests.url`.
 */
export function templateUrl(url: string): string {
  const raw = unwrapProxyUrl(url);
  const u = parseUrl(raw);
  // ponytail: unparseable → cut by hand, as Cordova does.
  return u ? `${u.host}${templatePath(u.pathname)}` : templatePath(raw.split(/[?#]/)[0] ?? '');
}

/** Templating, then the consumer's remove-only `sanitizeUrl` (throw or non-string → templated URL kept). */
export function scrubUrl(url: string, sanitizeUrl?: (url: string) => string): string {
  const templated = templateUrl(url);
  if (!sanitizeUrl) return templated;
  try {
    const out = sanitizeUrl(templated);
    return typeof out === 'string' ? out : templated;
  } catch {
    return templated;
  }
}

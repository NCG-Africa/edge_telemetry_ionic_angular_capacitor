/**
 * Query parameter names that are stripped from every captured URL by default.
 * Matches the list promised in docs/privacy.md.
 */
export const DEFAULT_SENSITIVE_PARAMS = [
  'token',
  'email',
  'phone',
  'key',
  'secret',
  'password',
  'auth',
] as const;

/**
 * Strips sensitive query params from a URL. Case-insensitive on param names.
 * Preserves non-sensitive params, hash fragments, and the path.
 * Returns the input unchanged if parsing fails.
 */
export function defaultSanitizeUrl(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return url;
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;

  const hashStart = url.indexOf('#', queryStart);
  const queryEnd = hashStart === -1 ? url.length : hashStart;
  const base = url.slice(0, queryStart);
  const query = url.slice(queryStart + 1, queryEnd);
  const hash = hashStart === -1 ? '' : url.slice(hashStart);

  if (query.length === 0) return url;

  const sensitive = new Set(DEFAULT_SENSITIVE_PARAMS.map((p) => p.toLowerCase()));
  const kept: string[] = [];
  for (const pair of query.split('&')) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawKey);
    } catch {
      decoded = rawKey;
    }
    if (sensitive.has(decoded.toLowerCase())) continue;
    kept.push(pair);
  }

  if (kept.length === 0) return base + hash;
  return `${base}?${kept.join('&')}${hash}`;
}

/**
 * Compose the default sanitizer with an optional user-provided one.
 * The default runs first, then the user's sanitizer gets the pre-cleaned URL.
 */
export function composeSanitizeUrl(
  userSanitizer?: (url: string) => string,
): (url: string) => string {
  if (!userSanitizer) return defaultSanitizeUrl;
  return (url: string) => {
    try {
      return userSanitizer(defaultSanitizeUrl(url));
    } catch {
      // If the user's sanitizer throws, fall back to the default-cleaned URL
      // so we never record a dirty URL because of a consumer bug.
      return defaultSanitizeUrl(url);
    }
  };
}

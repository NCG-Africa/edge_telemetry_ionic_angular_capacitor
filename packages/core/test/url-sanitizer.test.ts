import { describe, expect, it } from 'vitest';

import { isProxyUrl, scrubUrl, templateUrl, unwrapProxyUrl } from '../src/instrumentation/url-sanitizer';

describe('templateUrl (P2)', () => {
  it.each([
    ['https://api.example.com/users/12345/orders', 'https://api.example.com/users/{id}/orders'],
    ['https://api.example.com/v2/items/abc1', 'https://api.example.com/v2/items/{id}'],
    ['https://api.example.com/V10/x', 'https://api.example.com/V10/x'],
    ['https://api.example.com/f/550e8400-e29b-41d4-a716-446655440000', 'https://api.example.com/f/{id}'],
    [`https://api.example.com/t/${'a'.repeat(32)}`, 'https://api.example.com/t/{id}'],
    [`https://api.example.com/t/${'a'.repeat(31)}`, `https://api.example.com/t/${'a'.repeat(31)}`],
    ['https://api.example.com/a/b/c/d/e/f/g/h', 'https://api.example.com/a/b/c/d/e/f/…'],
    ['https://api.example.com/a/b/c/d/e/f', 'https://api.example.com/a/b/c/d/e/f'],
    ['https://api.example.com', 'https://api.example.com/'],
    ['https://api.example.com/items/', 'https://api.example.com/items'],
    ['https://api.example.com:8443/x', 'https://api.example.com:8443/x'],
  ])('%s → %s', (input, out) => {
    expect(templateUrl(input)).toBe(out);
  });

  it('drops query, fragment and userinfo', () => {
    expect(templateUrl('https://me:pw@api.example.com/s?q=hats&token=abc#top')).toBe('https://api.example.com/s');
  });

  it('cuts an unparseable URL by hand', () => {
    expect(templateUrl('/orders/42?x=1')).toBe('/orders/{id}');
  });

  it('unwraps a CapacitorHttp proxy URL before templating', () => {
    const proxy = `capacitor://localhost/_capacitor_http_interceptor_?u=${encodeURIComponent('https://api.example.com/users/7?token=t')}`;
    expect(isProxyUrl(proxy)).toBe(true);
    expect(unwrapProxyUrl(proxy)).toBe('https://api.example.com/users/7?token=t');
    expect(templateUrl(proxy)).toBe('https://api.example.com/users/{id}');
    expect(isProxyUrl('https://api.example.com/x?u=1')).toBe(false);
    const u = new URL('capacitor://localhost/_capacitor_http_interceptor_');
    u.searchParams.append('u', 'https://api.example.com/a b');
    expect(unwrapProxyUrl(u.href)).toBe('https://api.example.com/a b');
  });
});

describe('scrubUrl', () => {
  it('runs the consumer sanitizer on the templated URL', () => {
    const seen: string[] = [];
    const out = scrubUrl('https://api.example.com/users/42?token=t', (u) => {
      seen.push(u);
      return u.replace('/users', '');
    });
    expect(seen).toEqual(['https://api.example.com/users/{id}']);
    expect(out).toBe('https://api.example.com/{id}');
  });

  it('keeps the templated URL when the sanitizer throws or returns a non-string', () => {
    expect(scrubUrl('https://a.example.com/1', () => { throw new Error('x'); })).toBe('https://a.example.com/{id}');
    expect(scrubUrl('https://a.example.com/1', () => undefined as unknown as string)).toBe('https://a.example.com/{id}');
  });
});

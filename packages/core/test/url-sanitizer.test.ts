import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SENSITIVE_PARAMS,
  composeSanitizeUrl,
  defaultSanitizeUrl,
} from '../src/instrumentation/url-sanitizer';

describe('defaultSanitizeUrl', () => {
  it('returns the URL unchanged when no query string is present', () => {
    expect(defaultSanitizeUrl('https://api.example.com/users')).toBe(
      'https://api.example.com/users',
    );
  });

  it('returns the URL unchanged when the query has no sensitive params', () => {
    expect(
      defaultSanitizeUrl('https://api.example.com/search?q=hats&page=2'),
    ).toBe('https://api.example.com/search?q=hats&page=2');
  });

  it.each(DEFAULT_SENSITIVE_PARAMS.map((p) => [p]))(
    'strips %s query param',
    (param) => {
      const result = defaultSanitizeUrl(`https://api.example.com/resource?${param}=secretvalue`);
      expect(result).toBe('https://api.example.com/resource');
      expect(result).not.toContain('secretvalue');
      expect(result).not.toContain(param);
    },
  );

  it('strips sensitive params while preserving non-sensitive ones', () => {
    expect(
      defaultSanitizeUrl('https://api.example.com/s?q=hats&token=abc123&page=2'),
    ).toBe('https://api.example.com/s?q=hats&page=2');
  });

  it('strips multiple sensitive params in a single URL', () => {
    expect(
      defaultSanitizeUrl('https://api.example.com/x?token=t&q=hats&secret=s&auth=a'),
    ).toBe('https://api.example.com/x?q=hats');
  });

  it('is case-insensitive on param names', () => {
    expect(defaultSanitizeUrl('https://api.example.com/x?TOKEN=abc')).toBe(
      'https://api.example.com/x',
    );
    expect(defaultSanitizeUrl('https://api.example.com/x?Email=a@b')).toBe(
      'https://api.example.com/x',
    );
  });

  it('preserves the hash fragment', () => {
    expect(
      defaultSanitizeUrl('https://api.example.com/x?token=abc&q=hats#section'),
    ).toBe('https://api.example.com/x?q=hats#section');
  });

  it('preserves the hash fragment even when all query params are stripped', () => {
    expect(
      defaultSanitizeUrl('https://api.example.com/x?token=abc#section'),
    ).toBe('https://api.example.com/x#section');
  });

  it('handles an empty query string gracefully', () => {
    expect(defaultSanitizeUrl('https://api.example.com/x?')).toBe(
      'https://api.example.com/x?',
    );
  });

  it('handles params with no values', () => {
    expect(defaultSanitizeUrl('https://api.example.com/x?token&q=hats')).toBe(
      'https://api.example.com/x?q=hats',
    );
  });

  it('returns an empty or non-string input unchanged', () => {
    expect(defaultSanitizeUrl('')).toBe('');
    expect(defaultSanitizeUrl(null as unknown as string)).toBe(
      null as unknown as string,
    );
  });

  it('handles URL-encoded sensitive param names', () => {
    // %74%6f%6b%65%6e = "token"
    expect(
      defaultSanitizeUrl('https://api.example.com/x?%74%6f%6b%65%6e=abc&q=hats'),
    ).toBe('https://api.example.com/x?q=hats');
  });

  it('does not touch the path even if it contains a sensitive word', () => {
    // "/auth/login" should be preserved — only query params are sanitised
    expect(defaultSanitizeUrl('https://api.example.com/auth/login?q=hats')).toBe(
      'https://api.example.com/auth/login?q=hats',
    );
  });
});

describe('composeSanitizeUrl', () => {
  it('returns defaultSanitizeUrl when no user sanitizer is provided', () => {
    const fn = composeSanitizeUrl();
    expect(fn('https://api.example.com/x?token=abc&q=hats')).toBe(
      'https://api.example.com/x?q=hats',
    );
  });

  it('runs the default first, then the user sanitizer', () => {
    const userSanitizer = (url: string) => url.replace(/\/users\/\d+/, '/users/:id');
    const fn = composeSanitizeUrl(userSanitizer);
    // Both transformations should apply
    expect(fn('https://api.example.com/users/12345?token=abc')).toBe(
      'https://api.example.com/users/:id',
    );
  });

  it('falls back to the default-cleaned URL when the user sanitizer throws', () => {
    const userSanitizer = () => {
      throw new Error('bad sanitizer');
    };
    const fn = composeSanitizeUrl(userSanitizer);
    // Consumer bug must not result in a dirty URL being recorded
    expect(fn('https://api.example.com/x?token=abc&q=hats')).toBe(
      'https://api.example.com/x?q=hats',
    );
  });
});

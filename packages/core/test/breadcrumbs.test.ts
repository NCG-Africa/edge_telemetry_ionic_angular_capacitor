import { beforeEach, describe, expect, it } from 'vitest';

import { Breadcrumbs, breadcrumbs } from '../src/internal/breadcrumbs';

describe('Breadcrumbs', () => {
  beforeEach(() => {
    breadcrumbs.reset();
  });

  it('appends crumbs in order', () => {
    breadcrumbs.push({ ts: '2026-05-25T10:00:00.000Z', type: 'navigation', name: '/home' });
    breadcrumbs.push({ ts: '2026-05-25T10:00:01.000Z', type: 'http.request', name: 'https://api/x' });
    const snap = breadcrumbs.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap[0]!.name).toBe('/home');
    expect(snap[1]!.name).toBe('https://api/x');
  });

  it('caps at 20 entries (drops oldest)', () => {
    for (let i = 0; i < 25; i++) {
      breadcrumbs.push({ ts: `2026-05-25T10:00:${String(i).padStart(2, '0')}.000Z`, type: 'tick', name: `n_${i}` });
    }
    const snap = breadcrumbs.snapshot();
    expect(snap).toHaveLength(20);
    expect(snap[0]!.name).toBe('n_5');
    expect(snap[19]!.name).toBe('n_24');
  });

  it('snapshot returns a defensive copy', () => {
    breadcrumbs.push({ ts: 't', type: 'a', name: 'A' });
    const snap = breadcrumbs.snapshot();
    snap.push({ ts: 't2', type: 'b', name: 'B' });
    expect(breadcrumbs.snapshot()).toHaveLength(1);
  });

  it('reset() clears the buffer', () => {
    breadcrumbs.push({ ts: 't', type: 'a', name: 'A' });
    breadcrumbs.reset();
    expect(breadcrumbs.snapshot()).toEqual([]);
    expect(breadcrumbs.size()).toBe(0);
  });

  it('a fresh Breadcrumbs is isolated from the singleton', () => {
    breadcrumbs.push({ ts: 't', type: 'a', name: 'singleton' });
    const fresh = new Breadcrumbs();
    expect(fresh.snapshot()).toEqual([]);
    fresh.push({ ts: 't', type: 'a', name: 'private' });
    expect(breadcrumbs.snapshot()).toHaveLength(1);
    expect(fresh.snapshot()).toHaveLength(1);
  });
});

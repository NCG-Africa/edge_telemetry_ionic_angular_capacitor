import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectPlatformSync, generateSessionId } from '../src/session/SessionIdGenerator';

type CapacitorStub = { getPlatform?: () => string };

const g = globalThis as unknown as { Capacitor?: CapacitorStub };

describe('detectPlatformSync', () => {
  let originalCapacitor: CapacitorStub | undefined;

  beforeEach(() => {
    originalCapacitor = g.Capacitor;
  });

  afterEach(() => {
    if (originalCapacitor === undefined) {
      delete g.Capacitor;
    } else {
      g.Capacitor = originalCapacitor;
    }
  });

  it('returns "web" when globalThis.Capacitor is absent', () => {
    delete g.Capacitor;
    expect(detectPlatformSync()).toBe('web');
  });

  it('returns "ios" when Capacitor.getPlatform() reports ios', () => {
    g.Capacitor = { getPlatform: () => 'ios' };
    expect(detectPlatformSync()).toBe('ios');
  });

  it('returns "android" when Capacitor.getPlatform() reports android', () => {
    g.Capacitor = { getPlatform: () => 'android' };
    expect(detectPlatformSync()).toBe('android');
  });

  it('returns "web" when Capacitor.getPlatform() reports anything else', () => {
    g.Capacitor = { getPlatform: () => 'electron' };
    expect(detectPlatformSync()).toBe('web');
  });

  it('returns "web" when Capacitor.getPlatform throws', () => {
    g.Capacitor = {
      getPlatform: () => {
        throw new Error('boom');
      },
    };
    expect(detectPlatformSync()).toBe('web');
  });

  it('threads the detected platform through generateSessionId', () => {
    g.Capacitor = { getPlatform: () => 'ios' };
    const id = generateSessionId(detectPlatformSync());
    expect(id).toMatch(/^session_\d+_[0-9a-f]{16}_ios$/);
  });
});

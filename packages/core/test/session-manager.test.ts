import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionManager } from '../src/session/SessionManager';

describe('SessionManager', () => {
  let session: SessionManager;

  beforeEach(() => {
    session = new SessionManager({ platform: 'web' });
  });

  it('generates a session ID with the correct format', () => {
    expect(session.getSessionId()).toMatch(/^session_\d+_[0-9a-f]{8}_web$/);
  });

  it('starts with sequence 0', () => {
    expect(session.getSequence()).toBe(0);
  });

  it('increments sequence', () => {
    session.incrementSequence();
    session.incrementSequence();
    expect(session.getSequence()).toBe(2);
  });

  it('returns an ISO 8601 startTime', () => {
    expect(session.getStartTime()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('tracks lastActiveAt', () => {
    const before = Date.now();
    session.setLastActiveAt(before);
    expect(session.getLastActiveAt()).toBe(before);
  });

  it('detects session expiry after timeout', () => {
    session.setLastActiveAt(Date.now() - 31 * 60 * 1000);
    expect(session.isExpired()).toBe(true);
  });

  it('is not expired within timeout window', () => {
    session.setLastActiveAt(Date.now());
    expect(session.isExpired()).toBe(false);
  });

  it('startNewSession generates a new ID and resets state', () => {
    const oldId = session.getSessionId();
    session.incrementSequence();
    session.startNewSession();
    expect(session.getSessionId()).not.toBe(oldId);
    expect(session.getSequence()).toBe(0);
  });

  it('getSessionAttributes returns flat primitives', () => {
    const attrs = session.getSessionAttributes();
    expect(attrs['session.id']).toMatch(/^session_/);
    expect(attrs['session.startTime']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(attrs['session.sequence']).toBe(0);
    Object.values(attrs).forEach((v) => {
      expect(typeof v).toMatch(/^(string|number|boolean)$/);
    });
  });

  it('uses the provided platform in the session ID', () => {
    const iosSession = new SessionManager({ platform: 'ios' });
    expect(iosSession.getSessionId()).toMatch(/_ios$/);
  });
});

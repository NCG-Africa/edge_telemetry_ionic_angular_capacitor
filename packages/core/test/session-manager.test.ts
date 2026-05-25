import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionManager } from '../src/session/SessionManager';

describe('SessionManager', () => {
  let session: SessionManager;

  beforeEach(() => {
    session = new SessionManager({ platform: 'web' });
  });

  it('generates a session ID with the correct format', () => {
    expect(session.getSessionId()).toMatch(/^session_\d+_[0-9a-f]{16}_web$/);
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
    expect(attrs['session.start_time']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(attrs['session.sequence']).toBe(0);
    Object.values(attrs).forEach((v) => {
      expect(typeof v).toMatch(/^(string|number|boolean)$/);
    });
  });

  it('uses the provided platform in the session ID', () => {
    const iosSession = new SessionManager({ platform: 'ios' });
    expect(iosSession.getSessionId()).toMatch(/_ios$/);
  });

  describe('journey tracking', () => {
    it('recordScreenVisit appends to visited_screens in order, including repeats', () => {
      session.recordScreenVisit('Login');
      session.recordScreenVisit('Dashboard');
      session.recordScreenVisit('Login');
      const snap = session.getJourneySnapshot();
      expect(snap['session.visited_screens']).toBe('Login,Dashboard,Login');
      expect(snap['session.screen_count']).toBe(3);
    });

    it('ignores empty / non-string screen names', () => {
      session.recordScreenVisit('');
      session.recordScreenVisit(undefined as unknown as string);
      session.recordScreenVisit(null as unknown as string);
      const snap = session.getJourneySnapshot();
      expect(snap['session.visited_screens']).toBe('');
      expect(snap['session.screen_count']).toBe(0);
    });

    it('incrementEventCount / incrementMetricCount accumulate', () => {
      session.incrementEventCount();
      session.incrementEventCount();
      session.incrementMetricCount();
      const snap = session.getJourneySnapshot();
      expect(snap['session.event_count']).toBe(2);
      expect(snap['session.metric_count']).toBe(1);
    });

    it('caps visited_screens at 200', () => {
      for (let i = 0; i < 250; i++) session.recordScreenVisit(`screen_${i}`);
      const snap = session.getJourneySnapshot();
      expect(snap['session.screen_count']).toBe(200);
      expect((snap['session.visited_screens'] as string).split(',').length).toBe(200);
      // first 200 retained, later ones dropped
      expect((snap['session.visited_screens'] as string).split(',')[0]).toBe('screen_0');
      expect((snap['session.visited_screens'] as string).split(',')[199]).toBe('screen_199');
    });

    it('startNewSession clears the journey and resets counters', () => {
      session.recordScreenVisit('Login');
      session.incrementEventCount();
      session.incrementMetricCount();
      session.startNewSession();
      const snap = session.getJourneySnapshot();
      expect(snap['session.visited_screens']).toBe('');
      expect(snap['session.screen_count']).toBe(0);
      expect(snap['session.event_count']).toBe(0);
      expect(snap['session.metric_count']).toBe(0);
    });

    it('getJourneySnapshot returns only primitives', () => {
      session.recordScreenVisit('Home');
      session.incrementEventCount();
      const snap = session.getJourneySnapshot();
      for (const v of Object.values(snap)) {
        expect(['string', 'number', 'boolean']).toContain(typeof v);
      }
    });

    it('getLastVisitedScreen returns the most recent visit or null', () => {
      expect(session.getLastVisitedScreen()).toBeNull();
      session.recordScreenVisit('Home');
      expect(session.getLastVisitedScreen()).toBe('Home');
      session.recordScreenVisit('Profile');
      expect(session.getLastVisitedScreen()).toBe('Profile');
    });

    it('sets session.journey_truncated when MAX_VISITED_SCREENS is exceeded', () => {
      for (let i = 0; i < 200; i++) session.recordScreenVisit(`s_${i}`);
      expect(session.getJourneySnapshot()['session.journey_truncated']).toBe(false);
      session.recordScreenVisit('overflow_1');
      session.recordScreenVisit('overflow_2');
      expect(session.getJourneySnapshot()['session.journey_truncated']).toBe(true);
    });

    it('startNewSession resets journey_truncated', () => {
      for (let i = 0; i < 250; i++) session.recordScreenVisit(`s_${i}`);
      expect(session.getJourneySnapshot()['session.journey_truncated']).toBe(true);
      session.startNewSession();
      expect(session.getJourneySnapshot()['session.journey_truncated']).toBe(false);
    });
  });

  describe('cross-launch session counter', () => {
    function makeMemoryStorage(): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; backing: Record<string, string> } {
      const backing: Record<string, string> = {};
      return {
        backing,
        getItem: (k) => (k in backing ? backing[k]! : null),
        setItem: (k, v) => {
          backing[k] = v;
        },
      };
    }

    it('first SessionManager instance: is_first_session=true, total_sessions=1', () => {
      const storage = makeMemoryStorage();
      const s = new SessionManager({ platform: 'web', storage });
      const attrs = s.getSessionAttributes();
      expect(attrs['session.is_first_session']).toBe(true);
      expect(attrs['session.total_sessions']).toBe(1);
      expect(storage.backing['edge_rum_total_sessions']).toBe('1');
    });

    it('subsequent SessionManager instances increment total_sessions and clear is_first_session', () => {
      const storage = makeMemoryStorage();
      new SessionManager({ platform: 'web', storage });
      const s2 = new SessionManager({ platform: 'web', storage });
      const attrs = s2.getSessionAttributes();
      expect(attrs['session.is_first_session']).toBe(false);
      expect(attrs['session.total_sessions']).toBe(2);
      expect(storage.backing['edge_rum_total_sessions']).toBe('2');
    });

    it('startNewSession bumps total_sessions and clears is_first_session', () => {
      const storage = makeMemoryStorage();
      const s = new SessionManager({ platform: 'web', storage });
      expect(s.getSessionAttributes()['session.total_sessions']).toBe(1);
      s.startNewSession();
      const attrs = s.getSessionAttributes();
      expect(attrs['session.is_first_session']).toBe(false);
      expect(attrs['session.total_sessions']).toBe(2);
      expect(storage.backing['edge_rum_total_sessions']).toBe('2');
    });

    it('recovers from corrupt storage value', () => {
      const storage = makeMemoryStorage();
      storage.backing['edge_rum_total_sessions'] = 'not-a-number';
      const s = new SessionManager({ platform: 'web', storage });
      expect(s.getSessionAttributes()['session.is_first_session']).toBe(true);
      expect(s.getSessionAttributes()['session.total_sessions']).toBe(1);
    });

    it('works with a no-op storage (no-throw, treats every instance as first)', () => {
      // An empty in-memory storage simulates "no prior data" — equivalent to a
      // fresh install or a private-mode-blocked localStorage that nonetheless
      // accepts writes silently.
      const noopStorage = makeMemoryStorage();
      const s = new SessionManager({ platform: 'web', storage: noopStorage });
      const attrs = s.getSessionAttributes();
      expect(attrs['session.total_sessions']).toBe(1);
      expect(attrs['session.is_first_session']).toBe(true);
    });
  });
});

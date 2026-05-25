import { generateSessionId } from './SessionIdGenerator';

export const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_VISITED_SCREENS = 200;
const TOTAL_SESSIONS_STORAGE_KEY = 'edge_rum_total_sessions';

export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface SessionManagerOptions {
  platform?: string;
  sessionTimeoutMs?: number;
  storage?: StorageLike;
  sampleRate?: number;
}

export type JourneySnapshot = Record<string, string | number | boolean>;

function defaultLocalStorage(): StorageLike | undefined {
  if (typeof globalThis === 'undefined') return undefined;
  const g = globalThis as unknown as { localStorage?: StorageLike; sessionStorage?: StorageLike };
  // Try localStorage first; fall back to sessionStorage if access throws
  // (Safari private mode, third-party cookie blocking, etc.).
  try {
    const ls = g.localStorage;
    if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') {
      // Probe write so we detect quota / blocked-cookie failures up front.
      const probeKey = '__edge_rum_probe__';
      ls.setItem(probeKey, '1');
      try { ls.getItem(probeKey); } catch { /* probe read failure is fine */ }
      return ls;
    }
  } catch {
    // fall through
  }
  try {
    const ss = g.sessionStorage;
    if (ss && typeof ss.getItem === 'function' && typeof ss.setItem === 'function') {
      return ss;
    }
  } catch {
    // give up
  }
  return undefined;
}

function readTotalSessions(storage: StorageLike | undefined): number {
  if (!storage) return 0;
  try {
    const raw = storage.getItem(TOTAL_SESSIONS_STORAGE_KEY);
    if (raw === null) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeTotalSessions(storage: StorageLike | undefined, value: number): void {
  if (!storage) return;
  try {
    storage.setItem(TOTAL_SESSIONS_STORAGE_KEY, String(value));
  } catch {
    // private mode / quota — best-effort
  }
}

function clampSampleRate(rate: number | undefined): number {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return 1.0;
  if (rate <= 0) return 0;
  if (rate >= 1) return 1;
  return rate;
}

function rollSampled(rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return Math.random() < rate;
}

export class SessionManager {
  private sessionId: string;
  private startTime: string;
  private startTimeMs: number;
  private sequence: number;
  private lastActiveAt: number;
  private visitedScreens: string[] = [];
  private eventCount = 0;
  private metricCount = 0;
  private journeyTruncated = false;
  private totalSessions: number;
  private isFirstSession: boolean;
  private sampled: boolean;
  private readonly platform: string;
  private readonly sessionTimeoutMs: number;
  private readonly sampleRate: number;
  private readonly storage: StorageLike | undefined;

  constructor(options: SessionManagerOptions = {}) {
    this.platform = options.platform ?? 'web';
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.sampleRate = clampSampleRate(options.sampleRate);
    this.storage = options.storage ?? defaultLocalStorage();
    this.sessionId = generateSessionId(this.platform);
    this.startTimeMs = Date.now();
    this.startTime = new Date(this.startTimeMs).toISOString();
    this.sequence = 0;
    this.lastActiveAt = this.startTimeMs;
    this.sampled = rollSampled(this.sampleRate);

    const prev = readTotalSessions(this.storage);
    this.isFirstSession = prev === 0;
    this.totalSessions = prev + 1;
    writeTotalSessions(this.storage, this.totalSessions);
  }

  isSampled(): boolean {
    return this.sampled;
  }

  getStartTimeMs(): number {
    return this.startTimeMs;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getStartTime(): string {
    return this.startTime;
  }

  getSequence(): number {
    return this.sequence;
  }

  incrementSequence(): void {
    this.sequence++;
  }

  getLastActiveAt(): number {
    return this.lastActiveAt;
  }

  setLastActiveAt(timestampMs: number): void {
    this.lastActiveAt = timestampMs;
  }

  isExpired(): boolean {
    return Date.now() - this.lastActiveAt > this.sessionTimeoutMs;
  }

  startNewSession(): void {
    this.sessionId = generateSessionId(this.platform);
    this.startTimeMs = Date.now();
    this.startTime = new Date(this.startTimeMs).toISOString();
    this.sequence = 0;
    this.lastActiveAt = this.startTimeMs;
    this.visitedScreens = [];
    this.eventCount = 0;
    this.metricCount = 0;
    this.journeyTruncated = false;
    this.isFirstSession = false;
    this.totalSessions += 1;
    this.sampled = rollSampled(this.sampleRate);
    writeTotalSessions(this.storage, this.totalSessions);
  }

  recordScreenVisit(screen: string): void {
    if (typeof screen !== 'string' || screen.length === 0) return;
    if (this.visitedScreens.length >= MAX_VISITED_SCREENS) {
      this.journeyTruncated = true;
      return;
    }
    this.visitedScreens.push(screen);
  }

  getLastVisitedScreen(): string | null {
    return this.visitedScreens.length === 0
      ? null
      : (this.visitedScreens[this.visitedScreens.length - 1] ?? null);
  }

  incrementEventCount(): void {
    this.eventCount++;
  }

  incrementMetricCount(): void {
    this.metricCount++;
  }

  getJourneySnapshot(): JourneySnapshot {
    return {
      'session.visited_screens': this.visitedScreens.join(','),
      'session.screen_count': this.visitedScreens.length,
      'session.event_count': this.eventCount,
      'session.metric_count': this.metricCount,
      'session.journey_truncated': this.journeyTruncated,
    };
  }

  getSessionAttributes(): Record<string, string | number | boolean> {
    return {
      'session.id': this.sessionId,
      'session.start_time': this.startTime,
      'session.sequence': this.sequence,
      'session.is_first_session': this.isFirstSession,
      'session.total_sessions': this.totalSessions,
    };
  }
}

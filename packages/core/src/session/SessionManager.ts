import { generateSessionId } from './SessionIdGenerator';

export const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export interface SessionManagerOptions {
  platform?: string;
  sessionTimeoutMs?: number;
}

export class SessionManager {
  private sessionId: string;
  private startTime: string;
  private sequence: number;
  private lastActiveAt: number;
  private readonly platform: string;
  private readonly sessionTimeoutMs: number;

  constructor(options: SessionManagerOptions = {}) {
    this.platform = options.platform ?? 'web';
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.sessionId = generateSessionId(this.platform);
    this.startTime = new Date().toISOString();
    this.sequence = 0;
    this.lastActiveAt = Date.now();
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
    this.startTime = new Date().toISOString();
    this.sequence = 0;
    this.lastActiveAt = Date.now();
  }

  getSessionAttributes(): Record<string, string | number | boolean> {
    return {
      'session.id': this.sessionId,
      'session.startTime': this.startTime,
      'session.sequence': this.sequence,
    };
  }
}

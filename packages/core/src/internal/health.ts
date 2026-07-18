export class HealthMonitor {
  private errorCount = 0;
  private droppedCount = 0;
  private byScope: Record<string, number> = {};
  private debugMode = false;

  setDebug(debug: boolean): void {
    this.debugMode = debug;
  }

  reportError(scope: string, err: unknown): void {
    this.errorCount++;
    this.byScope[scope] = (this.byScope[scope] ?? 0) + 1;
    if (this.debugMode) {
      // eslint-disable-next-line no-console
      console.warn(`[edge-rum] ${scope}:`, err);
    }
  }

  // ADR-028. One monotonic per-session tally of telemetry deliberately shed
  // under backpressure (bounded live-buffer overflow + OfflineQueue overflow),
  // combined into a single total surfaced as sdk.dropped_count. Distinct from
  // reportError — this is data loss, not an SDK bug. `source` names the cap so
  // the debug log is actionable; it is not broken out on the wire.
  // A live-buffer drop sheds one event; an offline-queue drop sheds one queued
  // batch — different granularities into one combined total (ADR-028 dec.4), so
  // the log stays unit-neutral and just names the source.
  reportDrop(source: string): void {
    this.droppedCount++;
    if (this.debugMode) {
      // eslint-disable-next-line no-console
      console.warn(`[edge-rum] dropped under backpressure (${source}), session total: ${this.droppedCount}`);
    }
  }

  getErrorCount(): number {
    return this.errorCount;
  }

  getDroppedCount(): number {
    return this.droppedCount;
  }

  getErrorsByScope(): Record<string, number> {
    return { ...this.byScope };
  }

  reset(): void {
    this.errorCount = 0;
    this.droppedCount = 0;
    this.byScope = {};
    this.debugMode = false;
  }
}

export const healthMonitor = new HealthMonitor();

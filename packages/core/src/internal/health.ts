// ADR-031. On the 5th *consecutive* throw from a capture (with no successful
// event between them), the breaker disposes that capture itself. Internal
// constant — deliberately not an EdgeRumConfig field (ADR-031 decision 3).
const DISPOSE_AFTER_CONSECUTIVE_FAILURES = 5;

export class HealthMonitor {
  private errorCount = 0;
  private droppedCount = 0;
  private byScope: Record<string, number> = {};
  private debugMode = false;
  // ADR-031 circuit breaker. Keyed by capture name (scope before the first '.').
  private disposers: Record<string, () => void> = {};
  private consecutive: Record<string, number> = {};
  private disposed = new Set<string>();

  setDebug(debug: boolean): void {
    this.debugMode = debug;
  }

  // ADR-031. A capture registers the teardown for its one handle at startup,
  // next to where EdgeRum stores that handle. Only registered captures engage
  // the breaker — a reportError under an unregistered name just tallies.
  registerCapture(name: string, dispose: () => void): void {
    this.disposers[name] = dispose;
  }

  reportError(scope: string, err: unknown): void {
    this.errorCount++;
    this.byScope[scope] = (this.byScope[scope] ?? 0) + 1;
    if (this.debugMode) {
      // eslint-disable-next-line no-console
      console.warn(`[edge-rum] ${scope}:`, err);
    }

    // ADR-031. Trip unit is the whole capture, not the fine-grained scope.
    const capture = captureOf(scope);
    if (this.disposed.has(capture)) return;
    // Unregistered capture (or one whose handle never got created): tally only,
    // no-op the breaker.
    if (!(capture in this.disposers)) return;
    const next = (this.consecutive[capture] ?? 0) + 1;
    this.consecutive[capture] = next;
    if (next >= DISPOSE_AFTER_CONSECUTIVE_FAILURES) {
      this.tripCapture(capture);
    }
  }

  // ADR-031. A successful event resets the capture's consecutive counter, so
  // only an unbroken run of failures trips it. Called from the hot emit sites.
  reportSuccess(scope: string): void {
    const capture = captureOf(scope);
    if (this.disposed.has(capture)) return;
    if (this.consecutive[capture]) this.consecutive[capture] = 0;
  }

  // ADR-031. Fail-open teardown: mark disposed and stop counting regardless of
  // whether the capture's own dispose() throws; never rethrow to the host.
  private tripCapture(capture: string): void {
    this.disposed.add(capture);
    delete this.consecutive[capture];
    try {
      this.disposers[capture]?.();
    } catch (err) {
      if (this.debugMode) {
        // eslint-disable-next-line no-console
        console.warn(`[edge-rum] ${capture}: dispose threw during circuit-break`, err);
      }
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

  // ADR-031. Comma-joined capture names disposed this session ("" if none) —
  // surfaced as sdk.disposed_captures on session.finalized.
  getDisposedCaptures(): string {
    return [...this.disposed].join(',');
  }

  // ADR-028 dec.4 / #58. Zero the per-session tallies (error_count,
  // dropped_count) when a genuinely new session begins — init + rotation_timeout,
  // NOT resume. On mobile the JS context survives background→foreground, so
  // without this a rotated session's finalize would report the cumulative
  // process-lifetime total. Deliberately leaves the ADR-031 breaker state
  // (disposers, disposed set, consecutive run) intact: a disposed capture is
  // physically torn down and stays dead across the rotation.
  resetSessionTallies(): void {
    this.errorCount = 0;
    this.droppedCount = 0;
    this.byScope = {};
  }

  reset(): void {
    this.resetSessionTallies();
    this.debugMode = false;
    this.disposers = {};
    this.consecutive = {};
    this.disposed = new Set();
  }
}

// Capture name = substring before the first '.' — `frames.emit`,
// `frames.longtask.setup` and `frames.disconnect` all map to `frames`.
function captureOf(scope: string): string {
  const dot = scope.indexOf('.');
  return dot === -1 ? scope : scope.slice(0, dot);
}

export const healthMonitor = new HealthMonitor();

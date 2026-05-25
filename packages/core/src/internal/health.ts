export class HealthMonitor {
  private errorCount = 0;
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

  getErrorCount(): number {
    return this.errorCount;
  }

  getErrorsByScope(): Record<string, number> {
    return { ...this.byScope };
  }

  reset(): void {
    this.errorCount = 0;
    this.byScope = {};
    this.debugMode = false;
  }
}

export const healthMonitor = new HealthMonitor();

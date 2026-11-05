export interface Breadcrumb {
  ts: string;
  type: string;
  name: string;
  count?: number;
}

const MAX_BREADCRUMBS = 50; // A3 (= Cordova A3; native mirrors the same 50)

export class Breadcrumbs {
  private buffer: Breadcrumb[] = [];
  // Crumbs in an `enqueue` not yet failed or confirmed; a failure un-marks exactly its own.
  private shipped = new WeakSet<Breadcrumb>();

  push(crumb: Breadcrumb): void {
    this.buffer.push(crumb);
    if (this.buffer.length > MAX_BREADCRUMBS) {
      this.buffer.shift();
    }
  }

  // Console lines (ADR-029): collapse consecutive duplicates (same message) into one
  // crumb carrying `count`, so console spam can't evict the action trail. Only
  // console.error is captured — console.warn was dropped in ADR-029.
  pushConsole(message: string): void {
    const last = this.buffer[this.buffer.length - 1];
    if (last && last.type === 'console.error' && last.name === message) {
      last.count = (last.count ?? 1) + 1;
      return;
    }
    this.push({ ts: new Date().toISOString(), type: 'console.error', name: message, count: 1 });
  }

  snapshot(): Breadcrumb[] {
    return [...this.buffer];
  }

  /** A3: crumbs native hasn't been handed yet, now marked as handed. */
  take(): Breadcrumb[] {
    const fresh = this.buffer.filter((b) => !this.shipped.has(b));
    for (const b of fresh) this.shipped.add(b);
    return fresh;
  }

  /** A failed hand-off: hand these over again next time. */
  untake(crumbs: Breadcrumb[]): void {
    for (const b of crumbs) this.shipped.delete(b);
  }

  size(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.buffer = [];
    this.shipped = new WeakSet();
  }
}

export const breadcrumbs = new Breadcrumbs();

export interface Breadcrumb {
  ts: string;
  type: string;
  name: string;
  count?: number;
}

const MAX_BREADCRUMBS = 20;

export class Breadcrumbs {
  private buffer: Breadcrumb[] = [];

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

  size(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.buffer = [];
  }
}

export const breadcrumbs = new Breadcrumbs();

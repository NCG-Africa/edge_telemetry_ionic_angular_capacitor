export interface Breadcrumb {
  ts: string;
  type: string;
  name: string;
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

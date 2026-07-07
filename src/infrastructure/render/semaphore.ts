/** Tiny counting semaphore. #111 uses it to bound concurrent first-party POSTs per render
 *  (Chromium's per-origin limit). `tryAcquire` never awaits — a POST over the cap is aborted
 *  (`render_concurrency_limit`) rather than queued, so a render cannot stall on POST backpressure
 *  and a page cannot pin the event loop awaiting N POST slots. */
export class Semaphore {
  private available: number;
  constructor(permits: number) {
    this.available = permits;
  }
  tryAcquire(): boolean {
    if (this.available > 0) {
      this.available -= 1;
      return true;
    }
    return false;
  }
  release(): void {
    this.available += 1;
  }
}

/** An AWAITING counting semaphore: acquire() queues (await) when no permit is free, release()
 *  hands a permit to the head waiter. Used to bound concurrent render subresource FETCHES so the
 *  render byte pool's per-pool crossing overage stays within the bulk egress reservation (a GET
 *  response's size is unknown before the fetch, so concurrent fetches can each add a crossing body
 *  — bounding the in-flight count bounds the overage; codex R11 P1). */
export class AsyncSemaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];
  constructor(permits: number) { this.available = permits; }
  async acquire(): Promise<void> {
    if (this.available > 0) { this.available -= 1; return; }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) { next(); return; }
    this.available += 1;
  }
}


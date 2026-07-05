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

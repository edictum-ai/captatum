// LimitingFetcher — a FetcherPort wrapper that caps the GLOBAL concurrent
// fetchGuarded count across ALL callers (single-fetch + captatum_bulk seeds +
// Tier-3 render subresources) on the HOSTED flavor. This is BULK-2: without it,
// 8 concurrent bulks × maxConcurrency 4 = up to 32 concurrent fetches exceed the
// 2 vCPU / 4 GiB admission sizing. The local binary uses the RAW fetcher
// (single-user; per-call caps bound each call). See docs/contracts.md
// §"Hosted amplification controls".
//
// The acquire is bounded: a fetch that cannot get a global slot within its own
// timeoutMs (or the bulk wall signal, whichever fires first) rejects as
// `timeout` — no caller hangs on the global gate. Capacity bounds the unbounded
// worst case (admission 8 calls × maxConcurrency 4 = up to 32 fetches) below the
// 2 vCPU/4 GiB sizing. Single-fetch shares the FIFO pool with bulk seeds — it has
// NO priority, so under heavy concurrent bulk load a single-fetch MAY briefly queue
// (FIFO-fair; fails gracefully as a retriable `timeout` if its timeoutMs elapses).
// The inner fetch's timeoutMs is reduced by the time spent waiting
// for a slot so total wall stays ≈ the caller's timeoutMs (the per-tier timeout
// semantics are unchanged for single-fetch, which never waits). The SSRF guards,
// redirect re-validation, and Retry-After parsing all live in the INNER guarded
// fetcher — this wrapper only adds the global concurrency bound.
import type {
  FetcherOptions,
  FetcherPort,
  FetcherResult,
  PostInit,
  RejectResult,
} from "../../application/ports/fetcher.ts";

/** Floor for the inner fetch's timeoutMs after an acquire wait, so a fetch that
 *  just barely gets a slot still has a usable window. */
const MIN_INNER_TIMEOUT_MS = 1000;

export class LimitingFetcher implements FetcherPort {
  private readonly inner: FetcherPort;
  private readonly capacity: number;
  private active = 0;
  /** FIFO queue of pending resolve fns. A release transfers a slot directly to
   *  the head waiter (active unchanged) — see release(). */
  private readonly waiters: Array<(ok: boolean) => void> = [];

  constructor(inner: FetcherPort, capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`LimitingFetcher capacity must be a positive integer (got ${capacity})`);
    }
    this.inner = inner;
    this.capacity = capacity;
  }

  async fetchGuarded(url: string, opts: FetcherOptions, postInit?: PostInit): Promise<FetcherResult | RejectResult> {
    const start = Date.now();
    const acquired = await this.acquire(opts);
    if (!acquired) {
      return { rejected: true, code: "timeout", message: "Global fetch-concurrency limit reached" };
    }
    try {
      const waited = Date.now() - start;
      // Reduce the inner timeout by the slot-wait so the caller's overall wall
      // budget (timeoutMs) bounds wait + fetch. Only matters under global
      // contention (single-fetch never waits: capacity ≥ admission). Floor so a
      // fetch that waited nearly the full timeout still gets a usable window.
      const innerOpts = waited > 0
        ? { ...opts, timeoutMs: Math.max(MIN_INNER_TIMEOUT_MS, opts.timeoutMs - waited) }
        : opts;
      return await this.inner.fetchGuarded(url, innerOpts, postInit);
    } finally {
      this.release();
    }
  }

  /** Take a global slot. Returns true when a slot was taken (caller MUST release),
   *  false when the wait was bounded out by timeoutMs / opts.signal (no slot taken
   *  — the caller returns a `timeout` reject WITHOUT releasing). The handoff model
   *  mirrors the bulk Semaphore: release() transfers a slot to the head waiter
   *  WITHOUT changing `active`, so the slow path never re-increments it. */
  private async acquire(opts: FetcherOptions): Promise<boolean> {
    if (this.active < this.capacity) {
      this.active++;
      return true;
    }
    // Slow path: queue, bounded by the fetch's own timeoutMs + the caller signal.
    // A dedicated AbortController fires at timeoutMs so the wait can't outlive the
    // caller's wall budget; composed with opts.signal so the bulk wall deadline
    // yanks a queued seed into its deadline check.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;
    // If the composed signal is ALREADY aborted (caller wall already fired), AbortSignal.any is
    // born-aborted but addEventListener("abort") below would NOT fire (the event already happened),
    // leaving a dead waiter queued. Reject immediately — no slot taken (codex R8 P2).
    if (signal.aborted) { clearTimeout(timer); return false; }
    let resolveSlot!: (ok: boolean) => void;
    const wait = new Promise<boolean>((resolve) => { resolveSlot = resolve; });
    this.waiters.push(resolveSlot);
    const onAbort = (): void => {
      // Splice FIRST so a concurrent release can't hand a slot to a dead waiter
      // (which would silently drop capacity).
      const i = this.waiters.indexOf(resolveSlot);
      if (i >= 0) this.waiters.splice(i, 1);
      clearTimeout(timer);
      resolveSlot(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const ok = await wait;
      // Whether released or aborted, the timer is cleared (release via the line
      // below; abort via onAbort). Idempotent.
      clearTimeout(timer);
      return ok;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Transfer the slot to the head waiter (active UNCHANGED — the waiter's
      // acquire returns true without re-incrementing, since this slot is the one
      // the finishing caller just vacated). Re-incrementing would double-count
      // every handoff and inflate active past capacity forever.
      next(true);
      return;
    }
    if (this.active > 0) this.active--;
  }
}

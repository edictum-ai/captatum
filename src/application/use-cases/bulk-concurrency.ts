// Bounded-concurrency primitives for the captatum_bulk orchestrator. Kept dependency-
// free (no p-limit) so the orchestrator's amplification bounds are auditable in one
// place. The Semaphore bounds GLOBAL fetch concurrency (`maxConcurrency`); the
// PerHostGate bounds PER-HOST concurrency (`maxPerHostInflight` burst) + a polite
// crawl-delay (`crawlDelayMs`) between dispatches to the same host. Both are
// abort-aware: a sleep is resolved immediately when the wall signal fires so the
// caller reaches its deadline check without waiting out the sleep. No Date.now():
// all timing flows through the injected ClockPort.
import type { ClockPort } from "../ports/clock.ts";

/** Resolve after `ms`, but resolve IMMEDIATELY if `signal` aborts (so a wall-deadline
 *  abort yanks the seed out of a politeness wait and into its deadline check). Never
 *  rejects. The caller re-checks the deadline after the await. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => { clearTimeout(timer); resolve(); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A minimal async semaphore bounding concurrent entrants to `capacity`. FIFO fairness.
 *  Returns true when a slot was taken (caller MUST release), false when woken by abort
 *  (no slot taken — the caller skips without releasing). */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  async acquire(signal: AbortSignal): Promise<boolean> {
    if (this.active < this.capacity) { this.active++; return true; }
    // Slow path: queue for a slot. release() transfers a slot directly to the next waiter
    // (active unchanged), so the slow path does NOT re-increment active — doing so would
    // double-count every handoff and inflate the counter past capacity forever. On abort,
    // splice ourselves out of the queue FIRST so a later release can't hand a slot to a dead
    // waiter (which would silently drop capacity).
    let resolveSlot!: () => void;
    const wait = new Promise<void>((resolve) => { resolveSlot = resolve; });
    this.waiters.push(resolveSlot);
    const onAbort = (): void => {
      const i = this.waiters.indexOf(resolveSlot);
      if (i >= 0) this.waiters.splice(i, 1);
      resolveSlot();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await wait;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) return false; // woken by abort — no slot was taken
    return true; // slot handed off by release (active already accounts for it)
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) { next(); return; } // transfer the slot to the next waiter (active unchanged)
    if (this.active > 0) this.active--;
  }
}

/** Per-host politeness + rate gate, modeled as a token bucket: `burst` tokens are available
 *  instantly to a fresh host (the `maxPerHostInflight` burst), then refill at one token per
 *  `crawlDelayMs`. Keyed on the seed registrable domain (the only host known pre-egress).
 *  The union-keyed directed-DoS COUNT cap lives in the orchestrator; this bounds the RATE.
 *  `release` is a no-op: a token bucket refills over wall time, not on completion. */
export class PerHostGate {
  private readonly tokens = new Map<string, number>();
  private readonly lastRefill = new Map<string, number>();
  private readonly burst: number;
  private readonly crawlDelayMs: number;
  private readonly clock: ClockPort;
  constructor(burst: number, crawlDelayMs: number, clock: ClockPort) {
    this.burst = burst;
    this.crawlDelayMs = crawlDelayMs;
    this.clock = clock;
  }
  async acquire(host: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const now = this.clock.nowMs();
      const last = this.lastRefill.get(host);
      if (last === undefined) {
        // First request to this host: a full burst is available, take one instantly.
        this.tokens.set(host, this.burst - 1);
        this.lastRefill.set(host, now);
        return;
      }
      const current = this.tokens.get(host) ?? this.burst;
      const refilled = Math.min(this.burst, current + (now - last) / this.crawlDelayMs);
      if (refilled >= 1) {
        this.tokens.set(host, refilled - 1);
        this.lastRefill.set(host, now);
        return;
      }
      // No token yet: wait for the fractional refill, then re-check. abortableSleep returns
      // immediately on a wall-abort so the caller reaches its deadline check.
      await abortableSleep(Math.max(1, Math.ceil((1 - refilled) * this.crawlDelayMs)), signal);
    }
  }
  release(_host: string): void {
    // Token bucket refills over wall time; nothing to release per completion.
  }
}

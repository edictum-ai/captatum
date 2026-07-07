// InMemoryBulkQuotaPort — the default per-tenant rolling seed-window quota impl
// (BULK-1). A per-process Map<tenant, reservation[]>; each reservation is
// { at, seeds }. Lazily purged on access to entries newer than the window. This is
// the single-instance hosted default; a distributed store (shared across gateway
// replicas) is the multi-instance scale path (documented, not shipped). Pure: takes
// a ClockPort (no Date.now() in core). See docs/contracts.md §"Hosted amplification
// controls".
import type { ClockPort } from "../ports/clock.ts";
import type { BulkQuotaPort, QuotaReservation, QuotaResult } from "../ports/bulk-quota.ts";

interface Reservation {
  at: number;
  seeds: number;
}

export interface InMemoryBulkQuotaOptions {
  clock: ClockPort;
  /** Rolling window length in seconds. */
  windowSeconds: number;
  /** Max seeds a tenant may process within the window. */
  limit: number;
}

export class InMemoryBulkQuotaPort implements BulkQuotaPort {
  private readonly windows = new Map<string, Reservation[]>();
  private readonly clock: ClockPort;
  private readonly windowMs: number;
  private readonly limit: number;

  constructor(opts: InMemoryBulkQuotaOptions) {
    if (!Number.isInteger(opts.windowSeconds) || opts.windowSeconds < 1) {
      throw new Error(`InMemoryBulkQuotaPort windowSeconds must be a positive integer (got ${opts.windowSeconds})`);
    }
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw new Error(`InMemoryBulkQuotaPort limit must be a positive integer (got ${opts.limit})`);
    }
    this.clock = opts.clock;
    this.windowMs = opts.windowSeconds * 1000;
    this.limit = opts.limit;
  }

  async tryReserve(reservation: QuotaReservation): Promise<QuotaResult> {
    // Fail-closed: any unexpected failure (a future store impl could throw on I/O)
    // returns bulk_quota_store_error rather than admitting the call. The in-memory
    // Map does not throw in practice, but the guard keeps the contract honest for
    // a drop-in distributed impl.
    try {
      if (!reservation.tenant) {
        return { ok: false, code: "bulk_quota_store_error", message: "quota requires a tenant id" };
      }
      const now = this.clock.nowMs();
      const cutoff = now - this.windowMs;
      const active = (this.windows.get(reservation.tenant) ?? []).filter((r) => r.at > cutoff);
      const used = active.reduce((n, r) => n + r.seeds, 0);
      if (used + reservation.seeds > this.limit) {
        this.windows.set(reservation.tenant, active);
        return {
          ok: false,
          code: "bulk_quota_exceeded",
          // Hint: ms until the OLDEST active reservation rolls off (a lower bound
          // on when a same-size retry might fit; a smaller retry may fit sooner).
          ...(active.length > 0 ? { retryAfterMs: Math.max(0, active[0].at + this.windowMs - now) } : {}),
          windowSeconds: Math.round(this.windowMs / 1000),
          limit: this.limit,
          used,
        };
      }
      active.push({ at: now, seeds: reservation.seeds });
      this.windows.set(reservation.tenant, active);
      return {
        ok: true,
        reserved: reservation.seeds,
        windowSeconds: Math.round(this.windowMs / 1000),
        limit: this.limit,
        used: used + reservation.seeds,
      };
    } catch (error) {
      return {
        ok: false,
        code: "bulk_quota_store_error",
        message: error instanceof Error ? error.message : "quota store error",
      };
    }
  }
}

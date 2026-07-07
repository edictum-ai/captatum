// BulkQuotaPort — the per-tenant rolling seed-window quota that bounds a tenant's
// captatum_bulk amplification ACROSS calls (BULK-1). Each hosted bulk call reserves
// its processed-seed count against the calling tenant's window BEFORE any dispatch;
// a reservation that would exceed the window fails the whole call
// (`bulk_quota_exceeded`, retryable). The port is FAIL-CLOSED: a store error (or a
// missing tenant id when a quota port is configured) refuses the bulk
// (`bulk_quota_store_error`) rather than running unbounded — the safe direction.
// The local-binary flavor uses a noop port (single-user, unbounded by design).
// See docs/contracts.md §"Hosted amplification controls".

export interface QuotaReservation {
  /** The tenant id (the OAuth client id from CaptatumContext.clientId). */
  readonly tenant: string;
  /** The number of processed seeds this bulk call wants to count against the window. */
  readonly seeds: number;
}

export interface QuotaAllow {
  readonly ok: true;
  readonly reserved: number;
  readonly windowSeconds: number;
  readonly limit: number;
  readonly used: number;
}

export interface QuotaDenyExceeded {
  readonly ok: false;
  readonly code: "bulk_quota_exceeded";
  /** Hint: ms until enough of the window rolls off that a retry of the same size
   *  MIGHT fit (the oldest reservation's expiry — a lower bound). */
  readonly retryAfterMs?: number;
  readonly windowSeconds: number;
  readonly limit: number;
  readonly used: number;
}

export interface QuotaDenyStoreError {
  readonly ok: false;
  readonly code: "bulk_quota_store_error";
  readonly message?: string;
}

export type QuotaResult = QuotaAllow | QuotaDenyExceeded | QuotaDenyStoreError;

export interface BulkQuotaPort {
  /** Reserve `seeds` against the tenant's rolling window. FAIL-CLOSED: a store
   *  error returns `{ ok:false, code:"bulk_quota_store_error" }` rather than
   *  allowing the bulk unbounded. */
  tryReserve(reservation: QuotaReservation): Promise<QuotaResult>;
}

/** A quota port that admits everything (single-user local-binary flavor). Returns
 *  a zero-window/zero-limit `ok` so the orchestrator's audit + receipt fields are
 *  populated without enforcing a bound. */
export class NoopBulkQuotaPort implements BulkQuotaPort {
  async tryReserve(reservation: QuotaReservation): Promise<QuotaResult> {
    return { ok: true, reserved: reservation.seeds, windowSeconds: 0, limit: 0, used: 0 };
  }
}

/** Thrown by the orchestrator when the per-tenant quota refuses the call. Mapped by
 *  the MCP layer: `exceeded` is RETRYABLE (the client backs off and retries, like
 *  `OverloadedError`); `store_error` is a fail-closed refusal (non-retryable). */
export class BulkQuotaError extends Error {
  readonly code: "bulk_quota_exceeded" | "bulk_quota_store_error";
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(
    code: "bulk_quota_exceeded" | "bulk_quota_store_error",
    message: string,
    opts: { retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "BulkQuotaError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

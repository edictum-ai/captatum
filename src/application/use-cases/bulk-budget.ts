// BudgetTracker — the per-call accounting that bounds captatum_bulk's egress bytes,
// transform cost, and wall clock. The BulkGuard caps are the policy; this is the
// runtime enforcement. Two load-bearing mechanics:
//
// 1. DISPATCH-TIME RESERVATION (tightens the in-flight overshoot). Before a seed
//    fetches, `beforeSeed` reserves `perSeedMaxBytes` against the global byte cap and
//    `perSeedTransformCostUsd` against the global cost cap. The gate
//    `settled + reserved + perSeed ≤ cap` holds the invariant `settled + reserved ≤ cap`
//    at all times, so with `maxConcurrency` in flight the aggregate never exceeds the
//    cap (tighter than the no-reservation `cap + maxConcurrency × perSeedMaxBytes` bound
//    documented in contracts.md). A reservation that does not fit → the seed is not
//    dispatched (`bulk_budget_exceeded`/egress_bytes); a cost reservation that does not
//    fit → the seed still fetches but runs RAW (fail-soft: skip the LLM, keep the fetch).
//
// 2. POST-TRANSFORM GLOBAL RE-CHECK. A transform's ACTUAL cost can exceed its per-seed
//    reservation (the reservation is an estimate), so `afterSeed` records the real cost
//    and re-checks the GLOBAL cap; a breach short-circuits the REMAINING seeds
//    (`bulk_budget_exceeded`/transform_cost). The overshoot is bounded to one seed's
//    actual-minus-reserved; the per-seed actual is bounded by the transform's per-call cost
//    (input ∝ maxBytes + output ∝ the budget cap, × escalation attempts, now accumulated in
//    model-router so the recorded costUsd is the real per-seed spend).
//
// `beforeSeed`/`afterSeed` are SYNCHRONOUS and mutate shared counters; JS single-threaded
// async keeps them atomic between awaits, so interleaved concurrent seeds see a correct
// in-flight picture. See docs/contracts.md §"BulkGuard" + "In-flight discovery overshoot".
import type { ClockPort } from "../ports/clock.ts";

export type BudgetCapReason = "egress_bytes" | "transform_cost";

/** The render byte pool worst-case as a multiple of perSeedMaxBytes: the Tier-3 render fulfills
 *  essential subresources (ESSENTIAL_BUDGET_MULTIPLIER×, 3) + non-essential (1×) = 4×, ON TOP of
 *  the Tier-1 fetch beforeSeed already reserved (1×). Keep in sync with route-state.ts's pools. */
export const RENDER_EGRESS_MULTIPLIER = 4;

/** Result of reserving budget before dispatching a seed. */
export interface BeforeSeed {
  /** false → abort this seed BEFORE it fetches (a hard cap is full); `reason` names which. */
  readonly dispatch: boolean;
  /** false → run this seed RAW (the cost reservation did not fit — fail-soft: keep the
   *  fetch, skip the LLM). Only meaningful when `dispatch` is true and the caller asked
   *  for a non-raw output. */
  readonly runTransform: boolean;
  /** Set when `dispatch` is false. */
  readonly reason?: BudgetCapReason;
}

/** Result of recording a settled seed; whether a global cap is now breached. */
export interface AfterSeed {
  /** true → a global cap was breached by this seed's actuals; stop dispatching the rest. */
  readonly shortCircuit: boolean;
  readonly reason?: BudgetCapReason;
}

export interface BudgetTrackerOptions {
  clock: ClockPort;
  maxGlobalEgressBytes: number;
  maxGlobalWallMs: number;
  maxTransformCostUsd: number;
  perSeedTransformCostUsd: number;
  /** Per-seed response byte cap (the reservation unit for egress). */
  perSeedMaxBytes: number;
}

export class BudgetTracker {
  private bytesSettled = 0;
  private bytesReserved = 0;
  private costSettled = 0;
  private costReserved = 0;
  private inTokensUsed = 0;
  private outTokensUsed = 0;
  private readonly deadlineMs: number;
  private readonly opts: BudgetTrackerOptions;

  constructor(opts: BudgetTrackerOptions) {
    this.opts = opts;
    // The wall deadline is anchored at construction (the bulk call start). No Date.now():
    // the clock port is the single wall-clock source.
    this.deadlineMs = opts.clock.nowMs() + opts.maxGlobalWallMs;
  }

  /** Has the global wall deadline passed? (Separate from the byte/cost caps — surfaces
   *  as `bulk_deadline_exceeded`, not `bulk_budget_exceeded`.) */
  wallExceeded(): boolean {
    return this.opts.clock.nowMs() >= this.deadlineMs;
  }

  /** Does the in-flight cost wave (settled + outstanding reservations) exceed the global cap?
   *  A queued seed re-checks this after acquiring the transform slot: an earlier transform may
   *  have overspent its reservation (settled grew faster than reserved shrank), so even though
   *  settled alone is under the cap, settled + the still-outstanding reservations can exceed it.
   *  (Also trips when settled alone reaches the cap, since reserved ≥ the queued seed's own.) */
  costCapReached(): boolean {
    return this.costSettled + this.costReserved > this.opts.maxTransformCostUsd;
  }

  /** Reserve per-seed byte + cost budget before dispatching. See file header. */
  beforeSeed(): BeforeSeed {
    if (this.bytesSettled + this.bytesReserved + this.opts.perSeedMaxBytes > this.opts.maxGlobalEgressBytes) {
      return { dispatch: false, runTransform: false, reason: "egress_bytes" };
    }
    this.bytesReserved += this.opts.perSeedMaxBytes;
    // Fail-soft on cost: if the per-seed transform reservation does not fit the remaining
    // global budget, the seed still fetches but runs RAW (no LLM bill). `perSeed > 0` guards
    // a declared $0 ceiling (maxTransformCostUsd 0 clamps perSeed to 0): without it, the
    // `<=` would admit one paid transform at 0+0+0<=0 before afterSeed's re-check caught it.
    const runTransform = this.opts.perSeedTransformCostUsd > 0
      && this.costSettled + this.costReserved + this.opts.perSeedTransformCostUsd <= this.opts.maxTransformCostUsd;
    if (runTransform) this.costReserved += this.opts.perSeedTransformCostUsd;
    return { dispatch: true, runTransform };
  }

  /** Reserve an ADDITIONAL per-seed byte unit for a 429/503 retry (the retry does a second fetch
   *  of up to `perSeedMaxBytes`; `beforeSeed` reserved only one). Returns false (skip the retry)
   *  when the second fetch's egress would not fit under the global byte cap — so a retried seed
   *  cannot push egress past the hard cap (codex P2). The unit is released in `afterSeed` via
   *  `byteUnits`. */
  reserveRetry(): boolean { return this.reserveUnits(1); }

  /** Reserve the render byte pool (RENDER_EGRESS_MULTIPLIER × perSeedMaxBytes) before enabling a
   *  render — a render egresses the nav + essential/non-essential subresource pools (several×
   *  perSeedMaxBytes), so the single beforeSeed unit under-reserves it. Returns false (refuse the
   *  render) when the pool would not fit under the global cap (codex R5 P2). */
  reserveRender(): boolean { return this.reserveUnits(RENDER_EGRESS_MULTIPLIER); }

  /** Reserve `units` × perSeedMaxBytes; false when it would not fit under the global byte cap. */
  private reserveUnits(units: number): boolean {
    const add = this.opts.perSeedMaxBytes * units;
    if (this.bytesSettled + this.bytesReserved + add > this.opts.maxGlobalEgressBytes) return false;
    this.bytesReserved += add;
    return true;
  }

  /** Release a seed's reservation + record its ACTUAL bytes/cost, then re-check the global
   *  caps. `transformReserved` MUST mirror the `runTransform` returned by this seed's
   *  `beforeSeed` (the caller threads it through the await). `byteUnits` is the number of
   *  perSeedMaxBytes reservations held for this seed (1 normally, +RENDER_EGRESS_MULTIPLIER for a
   *  render, +1 for a retry). */
  afterSeed(args: {
    bytes: number;
    costUsd?: number;
    inTokens?: number;
    outTokens?: number;
    transformReserved: boolean;
    byteUnits?: number;
  }): AfterSeed {
    this.bytesReserved -= this.opts.perSeedMaxBytes * (args.byteUnits ?? 1);
    this.bytesSettled += args.bytes;
    if (args.transformReserved) {
      this.costReserved -= this.opts.perSeedTransformCostUsd;
      this.costSettled += args.costUsd ?? 0;
      this.inTokensUsed += args.inTokens ?? 0;
      this.outTokensUsed += args.outTokens ?? 0;
      if (this.costSettled > this.opts.maxTransformCostUsd) {
        return { shortCircuit: true, reason: "transform_cost" };
      }
    }
    // Reservation keeps settled ≤ cap, but defend against a malformed/oversized actual
    // (e.g. a future deep-egressBytes path) so the cap is never silently blown.
    if (this.bytesSettled > this.opts.maxGlobalEgressBytes) {
      return { shortCircuit: true, reason: "egress_bytes" };
    }
    return { shortCircuit: false };
  }

  /** Release a seed's dispatch-time reservation WITHOUT recording settled bytes/cost — for an
   *  abort path that reserved in `beforeSeed` but never executed (e.g. the wall fired while
   *  waiting for the transform slot, or a HARD short-circuit landed right after). `transformReserved`
   *  MUST mirror the `runTransform` returned by this seed's `beforeSeed`; `byteUnits` is the number
   *  of perSeedMaxBytes byte reservations held (default 1). */
  cancelReservation(transformReserved: boolean, byteUnits = 1): void {
    this.bytesReserved -= this.opts.perSeedMaxBytes * byteUnits;
    if (transformReserved) this.costReserved -= this.opts.perSeedTransformCostUsd;
  }

  get bytesUsed(): number { return this.bytesSettled; }
  get costUsed(): number { return this.costSettled; }
  get transformInTokens(): number { return this.inTokensUsed; }
  get transformOutTokens(): number { return this.outTokensUsed; }
}

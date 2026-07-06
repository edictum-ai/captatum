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
//    actual-minus-reserved, itself bounded by the model's per-call max (the `budget`
//    output-token cap).
//
// `beforeSeed`/`afterSeed` are SYNCHRONOUS and mutate shared counters; JS single-threaded
// async keeps them atomic between awaits, so interleaved concurrent seeds see a correct
// in-flight picture. See docs/contracts.md §"BulkGuard" + "In-flight discovery overshoot".
import type { ClockPort } from "../ports/clock.ts";

export type BudgetCapReason = "egress_bytes" | "transform_cost";

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

  /** Has the settled transform spend reached the global cost cap? (A transform landing exactly
   *  at the cap doesn't exceed it, so `afterSeed`'s strict `>` doesn't trip — but no FURTHER
   *  transform should run. Queued seeds re-check this after acquiring the transform slot.) */
  costCapReached(): boolean {
    return this.costSettled >= this.opts.maxTransformCostUsd;
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

  /** Release a seed's reservation + record its ACTUAL bytes/cost, then re-check the global
   *  caps. `transformReserved` MUST mirror the `runTransform` returned by this seed's
   *  `beforeSeed` (the caller threads it through the await). */
  afterSeed(args: {
    bytes: number;
    costUsd?: number;
    inTokens?: number;
    outTokens?: number;
    transformReserved: boolean;
  }): AfterSeed {
    this.bytesReserved -= this.opts.perSeedMaxBytes;
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

  get bytesUsed(): number { return this.bytesSettled; }
  get costUsed(): number { return this.costSettled; }
  get transformInTokens(): number { return this.inTokensUsed; }
  get transformOutTokens(): number { return this.outTokensUsed; }
}

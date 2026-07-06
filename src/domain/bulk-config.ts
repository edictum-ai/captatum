// Resolution of the effective BulkGuard from operator (deployment) + caller
// (per-call) inputs. Pure domain — split from bulk-policy.ts to respect the
// 250-line limit and to separate "what the caps are + the shaping math"
// (bulk-policy) from "how the effective guard is resolved" (this file). See
// docs/contracts.md §"Tool: captatum_bulk" / BulkGuard.
import type { Output } from "./tier.ts";
import {
  BULK_GUARD_CEILINGS,
  BULK_GUARD_DEFAULTS,
  BULK_RAW_MAX_URLS,
  BULK_SUMMARY_MAX_URLS,
  type BulkGuard,
} from "./bulk-policy.ts";

/** Operator (deployment) knobs — NOT caller-overridable; sourced from config. */
export interface BulkOperatorConfig {
  readonly maxPerHostInflight: number;
  readonly crawlDelayMs: number;
  readonly maxConcurrency: number;
}

/** Caller per-call overrides (founder decision 9): only the cost knobs. Clamped
 *  DOWN to BULK_GUARD_CEILINGS (a caller may cap lower, never raise). */
export interface BulkCallerOverride {
  readonly maxTransformCostUsd?: number;
  readonly perSeedTransformCostUsd?: number;
}

/** Resolve the effective guard: defaults overlaid with operator config, maxUrls
 *  from output, caller cost overrides clamped to ceilings. Returns which knobs
 *  were clamped (for receipt disclosure, decision 10). */
export function resolveBulkGuard(args: {
  operator: Partial<BulkOperatorConfig>;
  output: Output;
  caller?: BulkCallerOverride;
}): { guard: BulkGuard; clamped: string[] } {
  const clamped: string[] = [];
  const op = args.operator;
  const maxTransformCostUsd = clampMax(
    args.caller?.maxTransformCostUsd ?? BULK_GUARD_DEFAULTS.maxTransformCostUsd,
    BULK_GUARD_CEILINGS.maxTransformCostUsd, "maxTransformCostUsd", clamped,
  );
  const maxConcurrency = Math.min(
    BULK_GUARD_DEFAULTS.maxConcurrency, Math.max(1, op.maxConcurrency ?? BULK_GUARD_DEFAULTS.maxConcurrency),
  );
  let perSeedTransformCostUsd = clampMax(
    args.caller?.perSeedTransformCostUsd ?? BULK_GUARD_DEFAULTS.perSeedTransformCostUsd,
    BULK_GUARD_CEILINGS.perSeedTransformCostUsd, "perSeedTransformCostUsd", clamped,
  );
  // The per-seed cap is a SUB-BOUND of the global cap, SIZED FOR CONCURRENCY. Up
  // to maxConcurrency transforms run simultaneously, and each is checked against
  // the global cap only AFTER it settles — so maxConcurrency in-flight transforms
  // could otherwise collectively spend maxConcurrency × perSeed before the
  // post-transform re-check, blowing a caller's lower ceiling (e.g. global=$0.01,
  // perSeed=$0.05, conc=4 → $0.20 spent before re-check). Clamp perSeed to
  // global / maxConcurrency so the first wave can't exceed the caller's ceiling;
  // this also subsumes perSeed ≤ global (conc ≥ 1). Disclosed. (A runtime
  // reservation in the budget tracker, PR 2, can tighten this further.)
  const concurrentSafePerSeed = maxTransformCostUsd / maxConcurrency;
  if (perSeedTransformCostUsd > concurrentSafePerSeed) {
    perSeedTransformCostUsd = concurrentSafePerSeed;
    clamped.push("perSeedTransformCostUsd");
  }
  const maxPerHostInflight = Math.max(1, op.maxPerHostInflight ?? BULK_GUARD_DEFAULTS.maxPerHostInflight);
  const crawlDelayMs = Math.max(
    BULK_GUARD_CEILINGS.crawlDelayMsFloor, op.crawlDelayMs ?? BULK_GUARD_DEFAULTS.crawlDelayMs,
  );
  return {
    guard: {
      maxUrls: args.output === "raw" ? BULK_RAW_MAX_URLS : BULK_SUMMARY_MAX_URLS,
      maxPerHostInBulk: BULK_GUARD_DEFAULTS.maxPerHostInBulk,
      maxGlobalEgressBytes: BULK_GUARD_DEFAULTS.maxGlobalEgressBytes,
      maxGlobalWallMs: BULK_GUARD_DEFAULTS.maxGlobalWallMs,
      maxConcurrency,
      maxRenderedSeeds: BULK_GUARD_DEFAULTS.maxRenderedSeeds,
      maxPerHostInflight,
      crawlDelayMs,
      maxTransformCostUsd,
      perSeedTransformCostUsd,
    },
    clamped,
  };
}

function clampMax(value: number, ceiling: number, name: string, clamped: string[]): number {
  if (value > ceiling) {
    clamped.push(name);
    return ceiling;
  }
  return value;
}

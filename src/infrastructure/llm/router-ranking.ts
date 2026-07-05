import type { ModelHealth } from "./model-health.ts";
import type { LlmModelCandidate } from "./types.ts";

/** Configured order plus the sticky demotion offset (0 healthy / 1 demoted one rank). */
export function effectiveOrder(candidate: LlmModelCandidate, health: Map<string, ModelHealth>): number {
  return candidate.order + (health.get(candidate.model)?.demotion ?? 0);
}

/** Sticky demotion (0/1) — the load-bearing tiebreak after effective order. */
export function demotionOf(candidate: LlmModelCandidate, health: Map<string, ModelHealth>): number {
  return health.get(candidate.model)?.demotion ?? 0;
}

/** Principled tiebreak for equal effective orders: free before paid before local (+ cost weight).
 *  The old rank() MINUS the dead feedback-penalty term (the EMA is gone). */
export function staticRank(candidate: LlmModelCandidate): number {
  const localPenalty = candidate.local ? 0.45 : 0;
  const paidPenalty = candidate.free ? 0 : 0.25;
  return localPenalty + paidPenalty + candidate.costWeight;
}

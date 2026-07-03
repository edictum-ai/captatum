export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Server-side hard cap on output tokens. A caller's `budget` is clamped to this so
 *  paid generation can never run unbounded. A const (not env-tunable) so it cannot be
 *  raised above the router's reserved-output budget — see RESERVED_OUTPUT_TOKENS. */
export const MAX_OUTPUT_TOKENS_CAP = 4_000;

/** Default output-token cap when the caller omits `budget`. Operator-tunable via
 *  TRANSFORM_MAX_OUTPUT_TOKENS. Bounds cost/latency per call without an explicit budget. */
export const DEFAULT_OUTPUT_TOKENS = 2_000;

/** Resolve the bounded output-token cap: an explicit positive-integer budget wins
 *  (clamped to the hard cap); otherwise the default. Never undefined — closes the gap
 *  where an omitted budget left max_tokens/num_predict unset (JSON.stringify drops
 *  undefined fields), so providers generated with no server-side bound. */
export function resolveOutputCap(
  budget: number | undefined,
  defaultCap: number = DEFAULT_OUTPUT_TOKENS,
  hardCap: number = MAX_OUTPUT_TOKENS_CAP,
): number {
  const requested = typeof budget === "number" && Number.isInteger(budget) && budget > 0 ? budget : defaultCap;
  return Math.max(1, Math.min(requested, hardCap));
}

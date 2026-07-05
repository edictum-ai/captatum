export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Per-model max output tokens, from each provider's published limit (OpenRouter
 *  `top_provider.max_completion_tokens`). The configured flash models support far
 *  more than a single global cap — deepseek-v4-flash 16 384, qwen3.6-flash 65 536 —
 *  so a heavy doc page is no longer chopped at an artificial 4 K ceiling. A model
 *  not listed here falls back to {@link DEFAULT_MAX_OUTPUT_TOKENS}. Recheck the
 *  provider limit before adding/raising an entry. */
const MODEL_MAX_OUTPUT: Record<string, number> = {
  "deepseek/deepseek-v4-flash": 16_384,
  "qwen/qwen3.6-flash": 65_536,
};

/** Safe per-model default when a model is not in the registry. 16 384 is under the
 *  max of every commonly-configured flash model, so it never asks a model for more
 *  than it can generate. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/** Absolute output ceiling across all models (the largest registry entry). Used as
 *  the reserved-output budget for the context-fit gate so any model admitted by
 *  fits() can always hold its own max generation. A const (not env-tunable). */
export const MAX_OUTPUT_TOKENS_CAP = 65_536;

/** Default output-token budget when the caller omits `budget`. Operator-tunable via
 *  TRANSFORM_MAX_OUTPUT_TOKENS. Raised 2 000 → 8 000 (#125): 2 K was low enough that
 *  content-rich pages (a GitHub profile, a long article) silently truncated. */
export const DEFAULT_OUTPUT_TOKENS = 8_000;

/** A model's max output tokens (registry, else the safe default). */
export function modelMaxOutputTokens(model: string): number {
  return MODEL_MAX_OUTPUT[model] ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

/** Resolve the bounded output-token cap: an explicit positive-integer budget wins
 *  (clamped to the model's max); otherwise the default. `modelMax` (from
 *  {@link modelMaxOutputTokens}) caps paid generation at what the chosen model can
 *  actually produce. Never undefined — closes the gap where an omitted budget left
 *  max_tokens/num_predict unset (JSON.stringify drops undefined fields), so
 *  providers generated with no server-side bound. */
export function resolveOutputCap(
  budget: number | undefined,
  defaultCap: number = DEFAULT_OUTPUT_TOKENS,
  modelMax: number = MAX_OUTPUT_TOKENS_CAP,
): number {
  const requested = typeof budget === "number" && Number.isInteger(budget) && budget > 0 ? budget : defaultCap;
  return Math.max(1, Math.min(requested, modelMax));
}

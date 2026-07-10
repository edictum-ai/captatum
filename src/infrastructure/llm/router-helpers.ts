import type { ModelPickOptions, RouterProvider, RouterTask } from "../../application/ports/model-router.ts";
import type { TransformResult } from "../../application/ports/transformer.ts";
import type { TransformReason } from "../../domain/result.ts";
import type { LlmModelCandidate } from "./types.ts";

/** Does a candidate satisfy the pick constraints and fit the context window for the requested
 *  output budget? Reserve what will be requested (the passed cap clamped to the model max), not
 *  the bare model max, so a long page with a small/default budget isn't rejected for headroom it
 *  won't use (codex P2 #125). Falls back to the model max for direct pick callers. */
export function fits(
  candidate: LlmModelCandidate,
  task: RouterTask,
  inputTokens: number,
  options: ModelPickOptions,
): boolean {
  if (options.provider && candidate.provider !== options.provider) return false;
  if (options.model && candidate.model !== options.model) return false;
  if (options.exclude && options.exclude.includes(candidate.model)) return false;
  if (options.localOnly && !candidate.local) return false;
  if (task === "extract" && !candidate.supportsJson) return false;
  const reserve = options.reserveOutputTokens !== undefined
    ? Math.min(options.reserveOutputTokens, candidate.maxOutputTokens)
    : candidate.maxOutputTokens;
  return candidate.contextTokens >= inputTokens + reserve;
}

/** Why pick() returned provider "none" — surfaced as the raw-fallback reason (`TransformReason`). */
export function noneReason(options: ModelPickOptions, configuredCount: number): TransformReason {
  // No providers configured at all is the primary cause — check it first so a zero-candidate
  // local binary reports "unconfigured" even when the sensitive gate (localOnly) also fired
  // (the gate changed no outcome; mis-attributing it to "sensitive_content_no_local_provider"
  // hides that the binary simply has no provider).
  if (configuredCount === 0) return "unconfigured";
  if (options.localOnly) return "sensitive_content_no_local_provider";
  if (options.provider) return "provider_unconfigured";
  if (options.model) return "model_unavailable";
  return "no_model_fit";
}

/** Coerce a caller-supplied transform.provider override to a known provider id, or flag it
 *  unsupported (an unknown value returns "unsupported" so the transform short-circuits to raw). */
export function overrideProvider(value: unknown): Exclude<RouterProvider, "none"> | "unsupported" | undefined {
  if (value === undefined) return undefined;
  if (value === "openrouter" || value === "ollama") return value;
  return "unsupported";
}

/** Raw-content fallback: the transform produced no LLM result, so return the cleaned content with
 *  a `provider: "none"` reason. */
export function rawFallback(result: string, reason: TransformReason): TransformResult {
  return { result, info: { provider: "none", reason } };
}

/** Stable identity for a candidate (provider:model) — used as the health-map + tried-list key. */
export function candidateKey(candidate: LlmModelCandidate): string {
  return `${candidate.provider}:${candidate.model}`;
}

/** Split a comma-separated config list, trimming + dropping empties. */
export function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

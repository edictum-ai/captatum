import type { ModelRouterPort } from "../../application/ports/model-router.ts";
import { TransformError, type TransformInput } from "../../application/ports/transformer.ts";
import { parseJsonResult, validateJsonSchema } from "./json-schema.ts";
import { estimateTokens } from "./tokens.ts";

/**
 * Finalize a provider's raw text into the transform result: trim, run extract
 * JSON parsing + (advisory) schema validation when mode is extract, score the
 * model via the feedback bandit, and estimate out-tokens. Pure / side-effectful
 * only through `router.feedback`.
 */
export function finalize(
  input: TransformInput,
  text: string,
  model: string,
  router: ModelRouterPort,
  latencyMs: number,
  reportedOutTokens?: number,
): { result: string; outTokens: number; schemaIssue?: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    router.feedback({ model, score: 0, valid: false });
    throw new TransformError("transform_empty", "Provider returned an empty transform");
  }
  const extracted = input.mode === "extract"
    ? finalizeExtract(trimmed, input.schema, model, router)
    : undefined;
  const result = extracted ? extracted.result : trimmed;
  const outTokens = reportedOutTokens ?? estimateTokens(result);
  // On an extract schema mismatch finalizeExtract already applied a penalty
  // (score 0.3, valid:false). Skip the positive valid:true reward here so it
  // doesn't immediately cancel that penalty out (the model must not be rewarded
  // for schema-violating output). The valid-extract and non-extract paths still
  // score normally.
  if (!extracted?.schemaIssue) {
    router.feedback({ model, score: scoreTransform(result, outTokens, input.budget, latencyMs), valid: true });
  }
  return { result, outTokens, schemaIssue: extracted?.schemaIssue };
}

function finalizeExtract(
  text: string,
  schema: unknown,
  model: string,
  router: ModelRouterPort,
): { result: string; schemaIssue?: string } {
  let parsed: unknown;
  try {
    parsed = parseJsonResult(text);
  } catch {
    router.feedback({ model, score: 0, valid: false });
    throw new TransformError("extract_invalid_json", "Provider returned invalid JSON for extract output");
  }
  const validation = validateJsonSchema(parsed, schema);
  const result = JSON.stringify(parsed, null, 2);
  if (!validation.valid) {
    if (validation.unsupported) {
      // Fail closed for keywords this validator cannot check (e.g. format,
      // contentEncoding): we cannot verify them, so reject rather than accept
      // unvalidated structured data. (Contract: extract fails closed for
      // unsupported schema keywords.)
      router.feedback({ model, score: 0, valid: false });
      throw new TransformError("extract_schema_invalid", validation.message ?? "Schema uses an unsupported keyword");
    }
    router.feedback({ model, score: 0.3, valid: false });
    // Advisory: a supported-keyword value mismatch (wrong type, minLength, …).
    // Return parsed JSON (imperfect structured data > raw fallback) but surface
    // the mismatch as a non-fatal error so the caller is informed.
    return { result, schemaIssue: validation.message };
  }
  return { result };
}

function scoreTransform(result: string, outTokens: number, budget: number | undefined, latencyMs: number): number {
  let score = result ? 1 : 0;
  if (budget && outTokens > budget) score -= 0.35;
  if (latencyMs > 30_000) score -= 0.2;
  return clamp(score);
}

export function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

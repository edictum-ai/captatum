import type { ModelRouterPort } from "../../application/ports/model-router.ts";
import { TransformError, type TransformInput } from "../../application/ports/transformer.ts";
import { parseJsonResult, validateJsonSchema } from "./json-schema.ts";
import { estimateTokens } from "./tokens.ts";

/**
 * Finalize a provider's raw text into the transform result: trim, run extract JSON parsing +
 * (advisory) schema validation when mode is extract, report the attempt outcome to the router's
 * sticky health, and estimate out-tokens. Pure / side-effectful only through `router.feedback`.
 */
export function finalize(
  input: TransformInput,
  text: string,
  model: string,
  router: ModelRouterPort,
  reportedOutTokens?: number,
): { result: string; outTokens: number; schemaIssue?: string } {
  // Empty-completion handling moved to the model-router retry loop (#48 B): an
  // empty result now retries the next candidate (qwen) with `fallbackFrom`
  // instead of failing here. By this point text is guaranteed non-empty.
  const trimmed = text.trim();
  const extracted = input.mode === "extract"
    ? finalizeExtract(trimmed, input.schema, model, router)
    : undefined;
  const result = extracted ? extracted.result : trimmed;
  const outTokens = reportedOutTokens ?? estimateTokens(result);
  // The schema-mismatch advisory path (finalizeExtract) already recorded a 'soft' outcome for
  // this model — don't also record 'success' here (one outcome per attempt). The valid-extract
  // and non-extract paths record exactly one 'success'.
  if (!extracted?.schemaIssue) {
    router.feedback({ model, outcome: "success" });
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
    router.feedback({ model, outcome: "hard_fail" });
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
      router.feedback({ model, outcome: "hard_fail" });
      throw new TransformError("extract_schema_invalid", validation.message ?? "Schema uses an unsupported keyword");
    }
    // Advisory: a supported-keyword value mismatch (wrong type, minLength, …) — parseable but
    // non-conforming. Report 'soft' (NOT a hard failure — garbage-ish output can't be reliably
    // told from a legit short answer, so it must not feed demotion). Return the parsed JSON
    // (imperfect structured data > raw fallback) and surface the mismatch as a non-fatal
    // schemaIssue so the caller is informed.
    router.feedback({ model, outcome: "soft" });
    return { result, schemaIssue: validation.message };
  }
  return { result };
}

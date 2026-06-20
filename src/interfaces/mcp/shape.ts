import type { ProvenanceError, Result, TransformInfo } from "../../domain/result.ts";
import { classifyAccess, classifyContentType, hasContent, type AccessInfo, type ContentType } from "./classify.ts";

export type Status = "pass" | "partial" | "fail";

/**
 * Build the agent-facing MCP `structuredContent`. The default is a LEAN payload:
 * the load-bearing primitives agents/connectors already read (`result`, `tier`,
 * `title`, `output`, `code`, `bytes`, …) plus the new tiered fields (`ok`,
 * `status`, `contentType`, `access`, `provenance`, `warnings`, `images`) and a
 * lean transform. Heavy diagnostic fields (attempts, timings, full structured
 * data incl. JSON-LD description/articleBody, redirects, hashes) are gated
 * behind `debug: true`. The domain `Result` is never mutated.
 */
export function buildStructuredContent(result: Result, debug: boolean): Record<string, unknown> {
  const contentType = classifyContentType(result);
  const access = classifyAccess(result);
  const { errors, warnings } = splitErrors(result);
  const status = classifyStatus(result, warnings);

  const lean: Record<string, unknown> = {
    schemaVersion: result.schemaVersion,
    ok: status !== "fail",
    status,
    url: result.url,
    finalUrl: result.finalUrl,
    title: result.title,
    output: result.output,
    contentType,
    result: result.result,
    tier: result.tier,
    code: result.code,
    codeText: result.codeText,
    bytes: result.bytes,
    resolvedVia: result.resolvedVia,
    platform: result.platform,
    jsRequired: result.jsRequired,
    access,
    provenance: {
      tier: result.tier,
      resolvedVia: result.resolvedVia,
      code: result.code,
      bytes: result.bytes,
    },
    warnings,
    images: result.structured?.images ?? [],
    errors,
  };

  const transform = leanTransform(result.transform);
  if (transform) lean.transform = transform;

  if (debug) Object.assign(lean, debugFields(result));
  return prune(lean);
}

/** Fatal errors only surface when the run failed (`tier: "error"`); the rest are non-fatal warnings. */
function splitErrors(result: Result): { errors: ProvenanceError[]; warnings: ProvenanceError[] } {
  const fatal = result.tier === "error";
  return {
    errors: fatal ? result.errors : [],
    warnings: fatal ? [] : result.errors,
  };
}

function classifyStatus(result: Result, warnings: ProvenanceError[]): Status {
  if (result.tier === "error" || !hasContent(result)) return "fail";
  if (warnings.length > 0) return "partial";
  // Summary/extract requested but the transform fell back to raw — degraded.
  const t = result.transform;
  if (t && t.provider === "none" && (t.reason === "failed" || t.reason === "unconfigured")) {
    return "partial";
  }
  return "pass";
}

/** Token-efficiency + fallback signal only; latency/cost/schemaIssue move to debug. */
function leanTransform(transform: TransformInfo | undefined): Record<string, unknown> | undefined {
  if (!transform) return undefined;
  const lean: Record<string, unknown> = { provider: transform.provider };
  if (transform.model !== undefined) lean.model = transform.model;
  if (transform.free !== undefined) lean.free = transform.free;
  if (transform.inTokens !== undefined) lean.inTokens = transform.inTokens;
  if (transform.outTokens !== undefined) lean.outTokens = transform.outTokens;
  // reason is small and load-bearing: "failed"/"unconfigured" distinguishes a
  // silent raw fallback from a real summary without inspecting `status`.
  if (transform.reason !== undefined) lean.reason = transform.reason;
  return lean;
}

/** Heavy fields unlocked by `debug: true`, including the full structured payload. */
function debugFields(result: Result): Record<string, unknown> {
  const debug: Record<string, unknown> = {
    attempts: result.attempts,
    timings: result.timings,
    redirects: result.redirects,
    durationMs: result.durationMs,
    httpContentType: result.contentType,
    structured: result.structured,
  };
  if (result.contentSha256 !== undefined) debug.contentSha256 = result.contentSha256;
  if (result.provenanceHash !== undefined) debug.provenanceHash = result.provenanceHash;
  if (result.transform) debug.transform = { ...result.transform };
  return debug;
}

/** Drop top-level `undefined` values so the payload carries no empty keys. */
function prune(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val !== undefined) out[key] = val;
  }
  return out;
}

export type { ContentType, AccessInfo };

// Per-seed mapping helpers for captatum_bulk: single-fetch Result → BulkSeedResult,
// per-seed pass/partial/fail classification, and the never-ran (short-circuited) seed
// shape. Extracted from the orchestrator to respect the 250-line limit. Pure: only
// type imports + the shared hasContent classifier. See docs/contracts.md "BulkResult".
import { hasContent } from "../classify.ts";
import type { Tier, Output } from "../../domain/tier.ts";
import type { Result } from "../../domain/result.ts";
import type { BulkSeedResult } from "../../domain/bulk-result.ts";
import type { BulkStatus, ValidatedSeed } from "../../domain/bulk-policy.ts";

/** Per-entry snippet cap (the BulkResult.results[].result field — structuredContent +
 *  failures[]). */
export const SEED_SNIPPET_CHARS = 500;
/** Per-entry text-channel body cap (the fenced per-URL section in content[0].text). */
export const SEED_CONTENT_CHARS = 8_000;

export function snippet500(text: string): string {
  return text.length <= SEED_SNIPPET_CHARS ? text : `${text.slice(0, SEED_SNIPPET_CHARS - 1).trimEnd()}…`;
}

export function clipContent(text: string): string {
  return text.length <= SEED_CONTENT_CHARS ? text : `${text.slice(0, SEED_CONTENT_CHARS - 1).trimEnd()}…`;
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

/** Per-seed pass/partial/fail. Mirrors the MCP shape's classifyStatus: fail on tier:error,
 *  4xx/5xx, or empty body; partial on a non-fatal advisory or a transform that fell back
 *  to raw (provider none, failed/unconfigured); else pass. */
export function bulkSeedStatus(r: Result): BulkStatus {
  if (r.tier === "error" || Number(r.code) >= 400 || !hasContent(r)) return "fail";
  const t = r.transform;
  if (t && t.provider === "none" && (t.reason === "failed" || t.reason === "unconfigured")) return "partial";
  if (r.errors.length > 0) return "partial";
  return "pass";
}

/** Map a settled single-fetch Result to a BulkSeedResult row (INPUT ORDER is the caller's). */
export function toBulkSeedResult(seed: ValidatedSeed, r: Result, output: Output): BulkSeedResult {
  const fatal = r.tier === "error";
  const transform = r.transform
    ? {
        provider: r.transform.provider,
        ...(r.transform.model !== undefined ? { model: r.transform.model } : {}),
        ...(r.transform.reason !== undefined ? { reason: r.transform.reason } : {}),
        ...(r.transform.costUsd !== undefined ? { costUsd: r.transform.costUsd } : {}),
        ...(r.transform.inTokens !== undefined ? { inTokens: r.transform.inTokens } : {}),
        ...(r.transform.outTokens !== undefined ? { outTokens: r.transform.outTokens } : {}),
      }
    : undefined;
  return {
    url: seed.url,
    finalUrl: r.finalUrl,
    status: bulkSeedStatus(r),
    tier: r.tier as Tier,
    code: r.code,
    codeText: r.codeText,
    bytes: r.bytes,
    egressBytes: r.bytes, // v1: egressBytes = document bytes; deep subresource plumbing is PR 3
    output,
    platform: r.platform.adapterId,
    jsRequired: r.jsRequired,
    resolvedVia: r.resolvedVia,
    redirectHosts: r.redirects.map((rd) => hostOf(rd.url)),
    ...(r.contentSha256 !== undefined ? { contentSha256: r.contentSha256 } : {}),
    result: snippet500(r.result),
    content: clipContent(r.result),
    ...(transform !== undefined ? { transform } : {}),
    // errors vs warnings mirror the single-fetch MCP shape: fatal iff tier:error.
    warnings: fatal ? [] : r.errors.map((e) => ({ code: e.code, message: e.message })),
    errors: fatal ? r.errors.map((e) => ({ code: e.code, message: e.message })) : [],
  };
}

/** A seed that never ran — short-circuited by a cap (bulk_budget_exceeded /
 *  bulk_per_host_cap) or the wall (bulk_deadline_exceeded). tier:error, zero bytes. */
export function abortedSeedResult(seed: ValidatedSeed, code: string, message: string): BulkSeedResult {
  return {
    url: seed.url,
    finalUrl: seed.url,
    status: "fail",
    tier: "error",
    code: 0,
    codeText: code,
    bytes: 0,
    egressBytes: 0,
    output: "raw",
    platform: "generic",
    jsRequired: false,
    resolvedVia: "bulk-shortcut",
    redirectHosts: [],
    result: snippet500(message),
    content: snippet500(message),
    warnings: [],
    errors: [{ code, message }],
  };
}

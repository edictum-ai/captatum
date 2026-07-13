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
 *  4xx/5xx, or empty body; partial on a non-fatal advisory or a transform that fell back to
 *  raw (any provider:none degrade — #153 conformance fix); else pass. */
export function bulkSeedStatus(r: Result): BulkStatus {
  if (r.tier === "error" || Number(r.code) >= 400 || !hasContent(r)) return "fail";
  const t = r.transform;
  if (t && t.provider === "none") return "partial";
  if (r.errors.length > 0) return "partial";
  return "pass";
}

/** Map a settled single-fetch Result to a BulkSeedResult row (INPUT ORDER is the caller's). */
export function toBulkSeedResult(seed: ValidatedSeed, r: Result, output: Output): BulkSeedResult {
  const fatal = r.tier === "error";
  const recoveryWarnings = r.errors.filter((error) => error.code === "schema_knob_extracted");
  const errors = fatal ? r.errors.filter((error) => error.code !== "schema_knob_extracted") : [];
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
    egressBytes: r.egressBytes ?? r.bytes, // deep egress (Tier-3 subresources) when present, else document bytes (BULK-5)
    output,
    platform: r.platform.adapterId,
    jsRequired: r.jsRequired,
    resolvedVia: r.resolvedVia,
    redirectHosts: r.redirects.map((rd) => hostOf(rd.url)),
    ...(r.renderEgressHosts ? { renderEgressHosts: r.renderEgressHosts } : {}), // #154 (net-new in bulk rows)
    ...(r.renderDiagnostics ? { renderDiagnostics: r.renderDiagnostics } : {}), // #154
    ...(r.contentSha256 !== undefined ? { contentSha256: r.contentSha256 } : {}),
    result: snippet500(r.result),
    content: clipContent(r.result),
    ...(transform !== undefined ? { transform } : {}),
    // Errors vs warnings mirror the single-fetch MCP shape: recovery is advisory even on a fatal seed.
    warnings: fatal ? recoveryWarnings : r.errors.map((e) => ({ code: e.code, message: e.message })),
    errors,
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

/** A transform seed whose LLM call was abandoned at the bulk wall deadline (the wall signal
 *  can't cancel the provider call, so the orchestrator stops awaiting it). tier:error. */
export function wallAbandonedResult(seed: ValidatedSeed): Result {
  const message = "transform abandoned at the bulk wall deadline";
  return {
    url: seed.url, bytes: 0, code: 0, codeText: "FETCH_REJECTED", durationMs: 0, result: message,
    schemaVersion: 1, finalUrl: seed.url, redirects: [], tier: "error", output: "raw",
    platform: { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier1" },
    jsRequired: false, resolvedVia: "bulk-wall-abandon", attempts: [], contentType: "",
    timings: { totalMs: 0, fetchMs: 0 }, errors: [{ code: "bulk_deadline_exceeded", message }],
  };
}

/** Race an executor promise against the wall signal: if the deadline fires during a call the
 *  signal can't cancel (a slow LLM transform), abandon it with a deadline-fail result instead
 *  of holding the bulk open past the wall. The provider call is NOT canceled (it may finish
 *  wastefully), only un-awaited — the documented v1 dispatch-level abandonment. */
export async function raceWallAbort(p: Promise<Result>, signal: AbortSignal, seed: ValidatedSeed): Promise<Result> {
  if (signal.aborted) return wallAbandonedResult(seed);
  return Promise.race([
    p,
    new Promise<Result>((resolve) => signal.addEventListener("abort", () => resolve(wallAbandonedResult(seed)), { once: true })),
  ]);
}

/** A per-seed Result for an executor throw (unexpected — partial failure is normal, so the seed
 *  is marked tier:error fail, never propagated to a whole-call error). */
export function syntheticFail(seed: ValidatedSeed, err: unknown): Result {
  const message = err instanceof Error ? err.message : String(err);
  return {
    url: seed.url, bytes: 0, code: 0, codeText: "SEED_ERROR", durationMs: 0, result: message,
    schemaVersion: 1, finalUrl: seed.url, redirects: [], tier: "error", output: "raw",
    platform: { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier1" },
    jsRequired: false, resolvedVia: "seed-error", attempts: [], contentType: "",
    timings: { totalMs: 0, fetchMs: 0 }, errors: [{ code: "seed_error", message }],
  };
}

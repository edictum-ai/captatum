import { createHash } from "node:crypto";
import type { Tier, Output } from "./tier.ts";
import type { Platform, StructuredData } from "./platform.ts";

export interface Redirect {
  url: string;
  status: number;
}

export interface AttemptTrace {
  step: number;
  tier: Tier;
  outcome: "ok" | "escalate" | "block" | "error";
  status?: number;
  durationMs: number;
  bytes?: number;
  reason?: string;
}

/** Why a summary/extract degraded to raw (`transform.provider: "none"`). Typed enum so the
 *  receipt's degrade cause is a closed set (#153): `unconfigured` = no provider configured;
 *  `unsupported_provider` = an unrecognized caller `transform.provider` override;
 *  `provider_unconfigured`/`model_unavailable`/`no_model_fit`/`sensitive_content_no_local_provider`
 *  from the model router when no candidate could be picked; `transform_failed` = the provider ran
 *  and threw; `schema_validation_failed` = the extract output failed schema validation (normally
 *  caught earlier at the input boundary). */
export type TransformReason =
  | "unconfigured"
  | "unsupported_provider"
  | "provider_unconfigured"
  | "model_unavailable"
  | "no_model_fit"
  | "sensitive_content_no_local_provider"
  | "transform_failed"
  | "schema_validation_failed";

export interface TransformInfo {
  provider: string;
  model?: string;
  free?: boolean;
  inTokens?: number;
  outTokens?: number;
  latencyMs?: number;
  costUsd?: number;
  /** Degrade cause when `provider` is "none" (typed enum, #153). Absent on a successful transform. */
  reason?: TransformReason;
  /**
   * Non-fatal extract-schema mismatch message. When `output: extract` returns
   * parsed JSON that violates the requested schema, the data is still returned
   * (imperfect structured data > raw fallback) but this carries the validator's
   * message so the caller is not silently handed schema-violating data. The use
   * case surfaces it as a non-fatal `extract_schema_invalid` error.
   */
  schemaIssue?: string;
  /**
   * Comma-separated list of candidate models that FAILED before the successful one was used
   * (the router fell back). Present only when a fallback occurred. Operator-only (#82): a
   * successful fallback is silent in the user-facing receipt (`status` stays `pass`, no warning) —
   * this field carries the failed-primary list for `debug:true` and the audit log.
   */
  fallbackFrom?: string;
  /**
   * True when the summary/extract completed but was cut off at the output-token cap
   * (`finish_reason=length`) after budget escalation was exhausted — the result is
   * usable but incomplete. The use case surfaces this as a non-fatal
   * `transform_truncated` error so the caller is never silently handed a cut-off
   * answer (#125). Absent when the model finished cleanly (`finish_reason=stop`).
   */
  truncated?: boolean;
}

export interface Timings {
  totalMs: number;
  fetchMs: number;
  renderMs?: number;
  transformMs?: number;
}

export interface ProvenanceError {
  code: string;
  message: string;
}

export interface Result {
  // WebFetch-compatible core
  url: string;
  bytes: number;
  code: number;
  codeText: string;
  durationMs: number;
  result: string;
  // captatum provenance
  schemaVersion: 1;
  finalUrl: string;
  redirects: Redirect[];
  tier: Tier;
  output: Output;
  /** What the caller REQUESTED (vs `output`, the ACTUAL post-degrade mode). Stamped on the
   *  `applyOutputMode` + `rejectResult` paths; differs from `output` when a summary/extract
   *  degraded to raw. Absent on legacy/synthetic results. (#153) */
  outputRequested?: Output;
  platform: Platform;
  jsRequired: boolean;
  resolvedVia: string;
  attempts: AttemptTrace[];
  contentType: string;
  title?: string;
  structured?: StructuredData;
  transform?: TransformInfo;
  timings: Timings;
  errors: ProvenanceError[];
  /** Caller-injected ISO timestamp; no Date.now() in core. */
  fetchedAt?: string;
  /** sha256 over the canonical fetched/rendered bytes — content-addressable evidence (cache key, blob id, Edictum artifact id). */
  contentSha256?: string;
  /** sha256 over the stable JSON of the provenance envelope — attests how the result was produced. */
  provenanceHash?: string;
  /** Anti-bot challenge wall detected (cloudflare/akamai/perimeterx/…). When set,
   *  the fetched bytes are a bot-protection interstitial, not page content (#41 Half A). */
  challengeProvider?: string;
  /** Content-quality verdict for a successful fetch whose bytes aren't real/usable content:
   *  "app_error" = a client-app error-boundary screen (e.g. "Something went wrong") promoted as
   *  content — demoted to tier:error (#145); "low_value" = HTTP success but near-empty useful
   *  content (thin extraction) — a non-fatal warning, status partial (#150). Absent = normal. */
  contentQuality?: "app_error" | "low_value";
  /** Real NETWORK egress for the fetch. For Tier-1/Tier-2 this is the fetched
   *  document bytes (== `bytes`). For a Tier-3 render it is the render's total
   *  network egress (`essentialBytes + bytesFulfilled` — every subresource the
   *  browser loaded through `route.fulfill`), which is honest subresource
   *  accounting (BULK-5). `bytes` stays the document/DOM byte count. The bulk
   *  budget sums `egressBytes ?? bytes`. Absent on legacy single-fetch Tier-1
   *  results (additive, PR 3). */
  egressBytes?: number;
  /** The registrable domains a Tier-3 render loaded subresources from (script/xhr/
   *  fetch/stylesheet hosts that are NOT in the seed's redirect/finalUrl chain).
   *  Fed into the bulk per-host union count gate so a render-path directed victim
   *  is bounded by `maxPerHostInBulk` (BULK-3). Absent for Tier-1/Tier-2 (PR 3). */
  renderEgressHosts?: string[];
  /** Curated `Retry-After` (ms) from a 429/503 response. Carried from
   *  `FetcherResult.retryAfterMs`; the bulk orchestrator performs one jittered
   *  retry per 429/503 seed. Single-fetch surfaces it on the receipt but does not
   *  auto-retry (PR 3). */
  retryAfterMs?: number;
}

/** sha256 hex of a string. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Stable hash over the provenance envelope (fixed key order, null for absent
 * optional fields) so a Result can be cited/attested downstream. Excludes the
 * mutable text body — contentSha256 covers that separately.
 */
export function computeProvenanceHash(result: Result): string {
  const envelope = {
    url: result.url,
    finalUrl: result.finalUrl,
    tier: result.tier,
    code: result.code,
    output: result.output,
    resolvedVia: result.resolvedVia,
    jsRequired: result.jsRequired,
    contentSha256: result.contentSha256 ?? null,
    fetchedAt: result.fetchedAt ?? null,
    transformProvider: result.transform?.provider ?? null,
    transformModel: result.transform?.model ?? null,
  };
  return sha256Hex(JSON.stringify(envelope));
}

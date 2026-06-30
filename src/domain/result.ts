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

export interface TransformInfo {
  provider: string;
  model?: string;
  free?: boolean;
  inTokens?: number;
  outTokens?: number;
  latencyMs?: number;
  costUsd?: number;
  reason?: string;
  /**
   * Non-fatal extract-schema mismatch message. When `output: extract` returns
   * parsed JSON that violates the requested schema, the data is still returned
   * (imperfect structured data > raw fallback) but this carries the validator's
   * message so the caller is not silently handed schema-violating data. The use
   * case surfaces it as a non-fatal `extract_schema_invalid` error.
   */
  schemaIssue?: string;
  /**
   * Comma-separated list of candidate models that FAILED before the successful
   * one was used (the router fell back). Present only when a fallback occurred;
   * the use case surfaces it as a non-fatal `transform_model_fallback` warning
   * so the caller knows the output may be lower quality (and `status` becomes
   * `partial` rather than `pass`).
   */
  fallbackFrom?: string;
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

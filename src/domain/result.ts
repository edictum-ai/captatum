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
  // smart-fetch provenance
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
}

import type { Output } from "../../domain/tier.ts";
import type { TransformInfo } from "../../domain/result.ts";

export type TransformMode = "summarize" | "extract";

export type TransformOverride = {
  model?: string;
  provider?: string;
} & Record<string, unknown>;

export interface TransformInput {
  mode: TransformMode;
  output: Extract<Output, "summary" | "extract">;
  content: string;
  /** Content used for the sensitive-content scan (defaults to `content`). The
   *  orchestrator passes the PRE-ad-strip content here so the strip — an LLM-input
   *  optimization — can never affect the security gate (codex P1 on #46). */
  scanContent?: string;
  prompt: string;
  sourceUrl?: string;
  schema?: unknown;
  budget?: number;
  transform?: TransformOverride;
}

export interface TransformResult {
  result: string;
  info: TransformInfo;
}

export class TransformError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TransformError";
    this.code = code;
  }
}

/**
 * Summary/extract LLM seam. If this port is not configured, the P3 core
 * degrades summary/extract requests to raw with provider "none" provenance.
 */
export interface TransformPort {
  transform(input: TransformInput): Promise<TransformResult>;
  /** Whether any transform provider is configured (has model candidates). Used to
   *  pick the default output: summary when a provider exists, raw otherwise. Optional
   *  so test fakes need not implement it. */
  hasProvider?(): boolean;
}

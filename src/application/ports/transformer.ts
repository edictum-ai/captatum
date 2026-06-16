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
}

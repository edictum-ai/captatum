/**
 * Transform router port: picks a provider+model for the summary/extract stage, and receives
 * per-result feedback that drives sticky per-model health (a model demotes one rank only on
 * SUSTAINED hard failure — ≥3 of the last 5 attempts — so transient empties and soft/garbage
 * output don't demote). Implemented by src/infrastructure/llm/model-router.ts.
 *
 * See docs/contracts.md "Ports → ModelRouterPort" and "Transform".
 */

import type { TransformReason } from "../../domain/result.ts";

export type RouterTask = "summarize" | "extract";
export type RouterProvider = "openrouter" | "ollama" | "none";

export interface ModelPickOptions {
  provider?: Exclude<RouterProvider, "none">;
  model?: string;
  localOnly?: boolean;
  /** Models already tried in this transform — excluded so the router returns the next candidate. */
  exclude?: string[];
  /** Output tokens the caller will actually request from the picked model (the resolved cap).
   *  Reserved in the context-fit check so a long page with a small budget is not rejected for
   *  the model's MAX output (qwen 65K) it will never use. Defaults to the model's max (#125). */
  reserveOutputTokens?: number;
}

export interface ModelPick {
  provider: RouterProvider;
  model?: string;
  free?: boolean;
  /** The picked model's max output tokens (provider limit). The transformer clamps
   *  the budget to this so generation is bounded by what the model can actually
   *  produce (#125). Absent when provider is "none". */
  maxOutputTokens?: number;
  /** The picked model's context window (tokens). Bounds truncation escalation by the
   *  remaining context (context − input) so a long page isn't rejected for a model MAX
   *  the context can't hold (#125). Absent when provider is "none". */
  contextTokens?: number;
  /** Populated when provider is "none" (degrade to raw) — a typed `TransformReason` (#153). */
  reason?: TransformReason;
}

export interface ModelScore {
  model: string;
  /**
   * One attempt's outcome. `hard_fail` (provider throw / empty / non-2xx / invalid JSON /
   * unsupported schema keyword) pushes into the sticky window and may demote; `success` recovers;
   * `soft` (a parseable-but-schema-mismatched extract — garbage-ish, can't be reliably told from
   * a legit short answer) is a no-op so it never demotes.
   */
  outcome: "success" | "hard_fail" | "soft";
}

export interface ModelRouterPort {
  pick(task: RouterTask, inputTokens: number, options?: ModelPickOptions): ModelPick;
  feedback(score: ModelScore): void;
}

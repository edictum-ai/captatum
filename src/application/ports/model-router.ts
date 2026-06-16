/**
 * Transform router port: picks a provider+model for the summary/extract stage,
 * and receives per-result feedback for deterministic per-model EMA scoring
 * (flaky/garbage self-demotes). Implemented by src/infrastructure/llm/model-router.ts.
 *
 * See docs/contracts.md "Ports → ModelRouterPort" and "Transform".
 */

export type RouterTask = "summarize" | "extract";
export type RouterProvider = "openrouter" | "ollama" | "none";

export interface ModelPickOptions {
  provider?: Exclude<RouterProvider, "none">;
  model?: string;
  localOnly?: boolean;
}

export interface ModelPick {
  provider: RouterProvider;
  model?: string;
  free?: boolean;
  /** Populated when provider is "none" (degrade to raw). */
  reason?: string;
}

export interface ModelScore {
  model: string;
  /** 0..1; valid JSON? in-budget? non-empty? latency-weighted. */
  score: number;
  /** Whether the response was usable at all. */
  valid: boolean;
}

export interface ModelRouterPort {
  pick(task: RouterTask, inputTokens: number, options?: ModelPickOptions): ModelPick;
  feedback(score: ModelScore): void;
}

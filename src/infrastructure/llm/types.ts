import type { RouterTask } from "../../application/ports/model-router.ts";

export type LlmProviderId = "openrouter" | "ollama";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmModelCandidate {
  provider: LlmProviderId;
  model: string;
  free: boolean;
  local: boolean;
  supportsJson: boolean;
  contextTokens: number;
  /** Max output tokens the model can generate in one completion (provider limit).
   *  Drives the model-aware output cap (#125) — the budget is clamped to this so a
   *  heavy doc page is bound by the model's real ceiling, not a global const. */
  maxOutputTokens: number;
  costWeight: number;
  /** Position in the configured model list — the PRIMARY ranking key (#48 C: pin
   *  the configured order, e.g. deepseek before qwen, so the intended model is
   *  always tried first; the bandit only breaks ties). Local/Ollama uses a high
   *  default so configured hosted models rank first. */
  order: number;
}

export interface LlmGenerateInput {
  task: RouterTask;
  model: string;
  prompt: string;
  content: string;
  schema?: unknown;
  budget?: number;
  messages: LlmMessage[];
  /** Always bounded by the transformer via resolveOutputCap (#3) — required so no
   *  future caller can silently omit it and trigger unbounded provider generation. */
  maxOutputTokens: number;
}

export interface LlmGenerateResult {
  text: string;
  inTokens?: number;
  outTokens?: number;
  costUsd?: number;
  /** True when the provider stopped at the output-token cap (`finish_reason=length`
   *  / ollama `done_reason=length`) with non-empty text — the completion is usable
   *  but truncated. Distinct from an empty completion (a hard failure). The
   *  transformer escalates the budget and, if it still truncates, surfaces a
   *  `transform_truncated` advisory so the caller is never silently handed a
   *  cut-off answer (#125). */
  truncated?: boolean;
}

export interface LlmProvider {
  readonly id: LlmProviderId;
  candidates(): LlmModelCandidate[];
  generate(input: LlmGenerateInput): Promise<LlmGenerateResult>;
}

export type ProviderMap = Partial<Record<LlmProviderId, LlmProvider>>;

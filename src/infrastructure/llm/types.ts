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
}

export interface LlmProvider {
  readonly id: LlmProviderId;
  candidates(): LlmModelCandidate[];
  generate(input: LlmGenerateInput): Promise<LlmGenerateResult>;
}

export type ProviderMap = Partial<Record<LlmProviderId, LlmProvider>>;

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
}

export interface LlmGenerateInput {
  task: RouterTask;
  model: string;
  prompt: string;
  content: string;
  schema?: unknown;
  budget?: number;
  messages: LlmMessage[];
  maxOutputTokens?: number;
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

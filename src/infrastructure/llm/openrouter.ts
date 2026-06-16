import { postJson } from "./http-json.ts";
import type { LlmGenerateInput, LlmGenerateResult, LlmModelCandidate, LlmProvider } from "./types.ts";

const DEFAULT_CONTEXT_TOKENS = 128_000;
const DEFAULT_MODELS = ["google/gemini-2.0-flash-exp:free", "openrouter/auto"];

export interface OpenRouterProviderOptions {
  apiKey: string;
  baseUrl?: string;
  models?: string[];
  timeoutMs?: number;
}

export class OpenRouterProvider implements LlmProvider {
  readonly id = "openrouter" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly models: string[];
  private readonly timeoutMs: number;

  constructor(options: OpenRouterProviderOptions) {
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.models = options.models?.filter(Boolean) ?? DEFAULT_MODELS;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  candidates(): LlmModelCandidate[] {
    if (!this.apiKey) return [];
    return this.models.map((model) => ({
      provider: this.id,
      model,
      free: model.endsWith(":free"),
      local: false,
      supportsJson: true,
      contextTokens: DEFAULT_CONTEXT_TOKENS,
      costWeight: model.endsWith(":free") ? 0 : 0.12,
    }));
  }

  async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    const response = await postJson<OpenRouterResponse>(`${this.baseUrl}/chat/completions`, {
      authorization: `Bearer ${this.apiKey}`,
    }, {
      model: input.model,
      messages: input.messages,
      temperature: 0,
      max_tokens: input.maxOutputTokens,
      response_format: input.task === "extract" ? { type: "json_object" } : undefined,
    }, this.timeoutMs);
    const text = response.choices?.[0]?.message?.content;
    if (!text) throw new Error("OpenRouter returned an empty completion");
    return {
      text,
      inTokens: response.usage?.prompt_tokens,
      outTokens: response.usage?.completion_tokens,
      costUsd: numeric(response.usage?.cost),
    };
  }
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number | string;
  };
}

function numeric(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

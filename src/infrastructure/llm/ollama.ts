import { isLoopbackUrl, postJson } from "./http-json.ts";
import type { LlmGenerateInput, LlmGenerateResult, LlmModelCandidate, LlmProvider } from "./types.ts";

const DEFAULT_CONTEXT_TOKENS = 128_000;

export interface OllamaProviderOptions {
  baseUrl: string;
  model?: string;
  timeoutMs?: number;
}

export class OllamaProvider implements LlmProvider {
  readonly id = "ollama" as const;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/$/, "");
    this.model = options.model?.trim() || "llama3.1";
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  candidates(): LlmModelCandidate[] {
    if (!this.baseUrl) return [];
    // #4: `local` is derived from the base URL actually being loopback, not hardcoded.
    // A remote HTTPS OLLAMA_BASE_URL is local:false, so the sensitive-content gate
    // (localOnly) won't select it and flagged content falls back to raw rather than
    // egressing to a remote host. The "stays local" guarantee is loopback-derived.
    return [{
      provider: this.id,
      model: this.model,
      free: true,
      local: isLoopbackUrl(this.baseUrl),
      supportsJson: true,
      contextTokens: DEFAULT_CONTEXT_TOKENS,
      costWeight: 0,
      order: 1000,
    }];
  }

  async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    const response = await postJson<OllamaResponse>(`${this.baseUrl}/api/chat`, {}, {
      model: input.model,
      messages: input.messages,
      stream: false,
      format: input.task === "extract" ? "json" : undefined,
      options: {
        temperature: 0,
        num_predict: input.maxOutputTokens,
      },
    }, this.timeoutMs);
    const text = response.message?.content;
    if (!text) throw new Error("Ollama returned an empty completion");
    return {
      text,
      inTokens: response.prompt_eval_count,
      outTokens: response.eval_count,
    };
  }
}

interface OllamaResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

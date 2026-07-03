import { isLoopbackUrl, postJson } from "./http-json.ts";
import type { LlmGenerateInput, LlmGenerateResult, LlmModelCandidate, LlmProvider } from "./types.ts";

const DEFAULT_CONTEXT_TOKENS = 128_000;
const DEFAULT_MODELS = ["meta-llama/llama-3.3-70b-instruct:free", "openrouter/auto"];
const DISCOVER_TIMEOUT_MS = 8_000;

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
  /** Free models discovered live from GET /models (churn-safe); undefined until discovered. */
  private discovered: string[] | undefined;

  constructor(options: OpenRouterProviderOptions) {
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    assertHttpsEgress(this.baseUrl);
    this.models = options.models?.filter(Boolean) ?? DEFAULT_MODELS;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /**
   * Discover currently-free text models from OpenRouter /models. OpenRouter's free
   * pool churns constantly (models added, retired, rate-limited), so the candidate
   * set is fetched live rather than hardcoded — a static list goes stale within days.
   * Cached for the process; falls back to the static `models` list on any error or
   * when no key is configured. `openrouter/auto` is appended as a paid last resort.
   */
  async discover(): Promise<void> {
    if (this.discovered !== undefined) return;
    // A configured OPENROUTER_MODELS list is AUTHORITATIVE — do not let the live
    // free-model discovery override the user's chosen models. Discovery (which churns
    // and once pulled in coding models) is only the fallback when nothing is configured.
    if (this.models.length > 0) {
      this.discovered = this.models;
      return;
    }
    if (!this.apiKey) {
      this.discovered = DEFAULT_MODELS;
      return;
    }
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.discovered = DEFAULT_MODELS;
        return;
      }
      const payload = (await response.json()) as { data?: OpenRouterModel[] };
      const free = (payload.data ?? [])
        .filter(isFreeTextModel)
        .map((model) => model.id)
        .filter(Boolean);
      this.discovered = free.length > 0 ? [...new Set([...free, "openrouter/auto"])] : DEFAULT_MODELS;
    } catch {
      this.discovered = DEFAULT_MODELS;
    }
  }

  candidates(): LlmModelCandidate[] {
    if (!this.apiKey) return [];
    const models = this.discovered ?? this.models;
    return models.map((model, order) => ({
      provider: this.id,
      model,
      free: model.endsWith(":free"),
      local: false,
      supportsJson: true,
      contextTokens: DEFAULT_CONTEXT_TOKENS,
      costWeight: model.endsWith(":free") ? 0 : 0.12,
      order,
    }));
  }

  async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    // OpenRouter (and DeepSeek behind it) intermittently return an empty
    // completion under upstream capacity pressure — often clearing on a second
    // attempt. Retry once before letting the router demote to the next model.
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < GENERATE_ATTEMPTS; attempt++) {
      try {
        const response = await postJson<OpenRouterResponse>(`${this.baseUrl}/chat/completions`, {
          authorization: `Bearer ${this.apiKey}`,
        }, {
          model: input.model,
          messages: input.messages,
          temperature: 0,
          max_tokens: input.maxOutputTokens,
          response_format: input.task === "extract" ? { type: "json_object" } : undefined,
        }, this.timeoutMs);
        return parseOpenRouterCompletion(response);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < GENERATE_ATTEMPTS - 1) await sleep(RETRY_DELAY_MS);
      }
    }
    throw lastError ?? new Error("OpenRouter generate failed");
  }
}

const GENERATE_ATTEMPTS = 2;
const RETRY_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** #5: the OpenRouter API key egresses only over https://. Reject a non-loopback
 *  http:// baseUrl at construction — this covers BOTH generate() (via postJson) AND
 *  discover() (via native fetch, which bypasses postJson, so a transport-only guard
 *  would leave it exposed). Fails fast at config load rather than mid-request. A
 *  malformed baseUrl is left for the request layer to surface. */
function assertHttpsEgress(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return;
  }
  if (parsed.protocol === "http:" && !isLoopbackUrl(baseUrl)) {
    throw new Error(`OPENROUTER_BASE_URL must be https:// for a non-loopback host (refusing cleartext API-key egress): ${baseUrl}`);
  }
}

/**
 * Parse an OpenRouter chat-completion response into text + usage, or throw with
 * the REAL reason for failure. OpenRouter frequently returns HTTP 200 with the
 * error inline (top-level `error`, per-choice `error`, or `finish_reason`) — for
 * example DeepSeek capacity pressure surfaces as an empty `content`. Surfacing
 * the actual reason (instead of a generic "empty completion") makes model
 * failures diagnosable in the audit/warnings.
 */
export function parseOpenRouterCompletion(response: OpenRouterResponse): LlmGenerateResult {
  const choice = response.choices?.[0];
  const text = choice?.message?.content;
  const topError = errorMessage(response.error);
  const choiceError = errorMessage(choice?.error);
  if (topError || choiceError) {
    const code = response.error?.code ?? choice?.finish_reason ?? "error";
    throw new Error(`OpenRouter ${code}: ${topError ?? choiceError}`);
  }
  if (!text) {
    const reason = choice?.finish_reason && choice.finish_reason !== "stop"
      ? ` (finish_reason=${choice.finish_reason})`
      : "";
    throw new Error(`OpenRouter returned an empty completion${reason}`);
  }
  return {
    text,
    inTokens: response.usage?.prompt_tokens,
    outTokens: response.usage?.completion_tokens,
    costUsd: numeric(response.usage?.cost),
  };
}

function errorMessage(error: { message?: string } | undefined): string | undefined {
  return error?.message?.trim() || undefined;
}

interface OpenRouterModel {
  id: string;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modality?: string; output_modality?: string };
  context_length?: number;
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: { content?: string };
    error?: { message?: string };
    finish_reason?: string;
  }>;
  error?: { message?: string; code?: string };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number | string;
  };
}

export function isFreeTextModel(model: OpenRouterModel): boolean {
  if (model.pricing?.prompt !== "0") return false;
  const modality = model.architecture?.input_modality ?? "text";
  if (!modality.includes("text")) return false;
  // Reject code/image/audio/embed-specialized models for a general summarize/extract
  // tool. The contract (docs/contracts.md) promises this filter; without it the live
  // free-model discovery picked cohere/north-mini-code:free (a small coding model) for
  // summarize, producing vague output.
  const tags = `${model.id ?? ""} ${model.architecture?.output_modality ?? ""}`.toLowerCase();
  if (/\b(code|coder|coding)\b/.test(tags)) return false;
  if (/(image|text-to-image|diffusion|tts|speech|audio|whisper|rerank|embed)/.test(tags)) return false;
  return true;
}

function numeric(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

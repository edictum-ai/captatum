import { performance } from "node:perf_hooks";
import type { ClockPort } from "../../application/ports/clock.ts";
import type { ModelPick, ModelPickOptions, ModelRouterPort, ModelScore, RouterProvider, RouterTask } from "../../application/ports/model-router.ts";
import { TransformError, type TransformInput, type TransformPort, type TransformResult } from "../../application/ports/transformer.ts";
import { config } from "../../config.ts";
import { clamp, finalize } from "./finalize.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenRouterProvider } from "./openrouter.ts";
import { buildMessages } from "./prompts.ts";
import { detectSensitiveTransformInput } from "./safety.ts";
import { estimateTokens, normalizeBudget } from "./tokens.ts";
import type { LlmGenerateResult, LlmModelCandidate, ProviderMap } from "./types.ts";

const INITIAL_SCORE = 0.8;
const EMA_ALPHA = 0.25;
const RESERVED_OUTPUT_TOKENS = 2_000;

export class ModelRouter implements ModelRouterPort {
  private readonly candidatesByKey: Map<string, LlmModelCandidate>;
  private readonly scores = new Map<string, number>();

  constructor(candidates: LlmModelCandidate[]) {
    this.candidatesByKey = new Map(candidates.map((candidate) => [candidateKey(candidate), candidate]));
  }

  pick(task: RouterTask, inputTokens: number, options: ModelPickOptions = {}): ModelPick {
    const candidates = [...this.candidatesByKey.values()].filter((candidate) => fits(candidate, task, inputTokens, options));
    if (candidates.length === 0) return { provider: "none", reason: noneReason(options, this.candidatesByKey.size) };
    const [best] = candidates.sort((left, right) =>
      left.order - right.order || this.rank(left) - this.rank(right) || left.model.localeCompare(right.model));
    return { provider: best.provider, model: best.model, free: best.free };
  }

  feedback(score: ModelScore): void {
    const normalized = clamp(score.valid ? score.score : Math.min(score.score, 0.2));
    const previous = this.scores.get(score.model) ?? INITIAL_SCORE;
    this.scores.set(score.model, previous * (1 - EMA_ALPHA) + normalized * EMA_ALPHA);
  }

  scoreFor(model: string): number {
    return this.scores.get(model) ?? INITIAL_SCORE;
  }

  private rank(candidate: LlmModelCandidate): number {
    const feedbackPenalty = 1 - this.scoreFor(candidate.model);
    const localPenalty = candidate.local ? 0.45 : 0;
    const paidPenalty = candidate.free ? 0 : 0.25;
    return localPenalty + paidPenalty + candidate.costWeight + feedbackPenalty;
  }
}

export interface LlmTransformerOptions {
  router: ModelRouterPort;
  providers: ProviderMap;
  clock?: ClockPort;
}

export class LlmTransformer implements TransformPort {
  private readonly router: ModelRouterPort;
  private readonly providers: ProviderMap;
  private readonly clock?: ClockPort;

  constructor(options: LlmTransformerOptions) {
    this.router = options.router;
    this.providers = options.providers;
    this.clock = options.clock;
  }

  async transform(input: TransformInput): Promise<TransformResult> {
    const messages = buildMessages(input);
    const inTokens = estimateTokens(messages.map((message) => message.content).join("\n"));
    const override = overrideProvider(input.transform?.provider);
    if (override === "unsupported") return rawFallback(input.content, "unsupported_provider");

    const sensitive = detectSensitiveTransformInput({
      content: input.scanContent ?? input.content,
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    });
    const baseOptions: ModelPickOptions = {
      provider: sensitive.sensitive ? undefined : override,
      model: typeof input.transform?.model === "string" ? input.transform.model : undefined,
      localOnly: sensitive.sensitive,
    };

    // Try candidate models in router-ranked order; on a provider error (dead model,
    // 429 rate-limit, timeout) demote via the bandit and try the next free model.
    // Only degrade after every candidate is exhausted.
    const tried: string[] = [];
    let lastError: Error | undefined;
    while (true) {
      const pick = this.router.pick(input.mode, inTokens, { ...baseOptions, exclude: tried });
      if (pick.provider === "none" || !pick.model) {
        if (tried.length === 0) return rawFallback(input.content, pick.reason ?? "unconfigured");
        throw new TransformError(
          "transform_provider_failed",
          errorMessage(lastError, `All ${tried.length} candidate model(s) failed`),
        );
      }
      const provider = this.providers[pick.provider];
      if (!provider) {
        tried.push(pick.model);
        continue;
      }

      const started = this.nowMs();
      let generated: LlmGenerateResult;
      try {
        generated = await provider.generate({
          task: input.mode,
          model: pick.model,
          prompt: input.prompt,
          content: input.content,
          schema: input.schema,
          budget: input.budget,
          messages,
          maxOutputTokens: normalizeBudget(input.budget),
        });
        // #48 B: an empty completion (DeepSeek capacity pressure) is a failure —
        // retry the next candidate (qwen) with `fallbackFrom`, instead of failing
        // the whole transform (which previously yielded a raw dump + demotion).
        if (!generated.text.trim()) {
          throw new TransformError("transform_empty", `${pick.model} returned an empty completion`);
        }
      } catch (error) {
        this.router.feedback({ model: pick.model, score: 0, valid: false });
        tried.push(pick.model);
        lastError = error instanceof Error ? error : new Error(String(error));
        process.stderr.write(`captatum transform: ${pick.model} failed: ${lastError.message}\n`);
        continue;
      }

      const latencyMs = elapsed(started, this.nowMs());
      const finalized = finalize(input, generated.text, pick.model, this.router, latencyMs, generated.outTokens);
      return {
        result: finalized.result,
        info: {
          provider: pick.provider,
          model: pick.model,
          free: pick.free,
          inTokens: generated.inTokens ?? inTokens,
          outTokens: finalized.outTokens,
          latencyMs,
          costUsd: generated.costUsd,
          ...(finalized.schemaIssue ? { schemaIssue: finalized.schemaIssue } : {}),
          // tried holds every candidate that failed before this one succeeded.
          ...(tried.length > 0 ? { fallbackFrom: tried.join(", ") } : {}),
        },
      };
    }
  }

  private nowMs(): number {
    return this.clock?.nowMs() ?? performance.now();
  }
}

export async function createDefaultLlmTransformer(): Promise<LlmTransformer> {
  const openRouter = new OpenRouterProvider({
    apiKey: config.transform.openRouterApiKey(),
    baseUrl: config.transform.openRouterBaseUrl(),
    models: splitList(config.transform.openRouterModels()),
    timeoutMs: config.transform.timeoutMs(),
  });
  const ollama = new OllamaProvider({
    baseUrl: config.transform.ollamaBaseUrl(),
    model: config.transform.ollamaModel(),
    timeoutMs: config.transform.timeoutMs(),
  });
  // Discover OpenRouter's currently-free models live (the pool churns constantly).
  await openRouter.discover();
  const providers = { openrouter: openRouter, ollama };
  return new LlmTransformer({ router: new ModelRouter([...openRouter.candidates(), ...ollama.candidates()]), providers });
}

function fits(candidate: LlmModelCandidate, task: RouterTask, inputTokens: number, options: ModelPickOptions): boolean {
  if (options.provider && candidate.provider !== options.provider) return false;
  if (options.model && candidate.model !== options.model) return false;
  if (options.exclude && options.exclude.includes(candidate.model)) return false;
  if (options.localOnly && !candidate.local) return false;
  if (task === "extract" && !candidate.supportsJson) return false;
  return candidate.contextTokens >= inputTokens + RESERVED_OUTPUT_TOKENS;
}

function noneReason(options: ModelPickOptions, configuredCount: number): string {
  if (options.localOnly) return "sensitive_content_no_local_provider";
  if (options.provider) return "provider_unconfigured";
  if (options.model) return "model_unavailable";
  return configuredCount === 0 ? "unconfigured" : "no_model_fit";
}

function overrideProvider(value: unknown): Exclude<RouterProvider, "none"> | "unsupported" | undefined {
  if (value === undefined) return undefined;
  if (value === "openrouter" || value === "ollama") return value;
  return "unsupported";
}

function rawFallback(result: string, reason: string): TransformResult {
  return { result, info: { provider: "none", reason } };
}

function candidateKey(candidate: LlmModelCandidate): string {
  return `${candidate.provider}:${candidate.model}`;
}

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function elapsed(startMs: number, endMs: number): number {
  return Math.max(0, Math.round(endMs - startMs));
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

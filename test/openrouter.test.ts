import assert from "node:assert/strict";
import { test } from "node:test";
import { isFreeTextModel, OpenRouterProvider, parseOpenRouterCompletion } from "../src/infrastructure/llm/openrouter.ts";

const free = (overrides: Record<string, unknown> = {}) => ({
  id: "meta-llama/llama-3.3-70b-instruct:free",
  pricing: { prompt: "0" },
  architecture: { input_modality: "text", output_modality: "text" },
  ...overrides,
});

test("isFreeTextModel accepts a general free text instruct model", () => {
  assert.equal(isFreeTextModel(free()), true);
});

test("isFreeTextModel rejects paid models", () => {
  assert.equal(isFreeTextModel(free({ pricing: { prompt: "0.0001" } })), false);
});

test("isFreeTextModel rejects coding models (the prod audit regression: cohere/north-mini-code:free)", () => {
  assert.equal(isFreeTextModel(free({ id: "cohere/north-mini-code:free" })), false);
  assert.equal(isFreeTextModel(free({ id: "deepseek/deepseek-coder:free" })), false);
  assert.equal(isFreeTextModel(free({ id: "qwen/qwen2.5-coder-7b-instruct:free" })), false);
});

test("isFreeTextModel rejects image/audio/embed/rerank models (by id/output_modality)", () => {
  // A text+image INPUT model is still usable for text tasks, so it is accepted; the
  // filter rejects on id / output_modality keywords instead.
  assert.equal(isFreeTextModel(free({ architecture: { input_modality: "text+image->text" } })), true);
  assert.equal(isFreeTextModel(free({ id: "openai/whisper-1:free", architecture: { output_modality: "audio" } })), false);
  assert.equal(isFreeTextModel(free({ id: "x/text-to-image:free" })), false);
  assert.equal(isFreeTextModel(free({ id: "x/text-embedding-3:free" })), false);
});

test("isFreeTextModel keeps a non-coder qwen model", () => {
  assert.equal(isFreeTextModel(free({ id: "qwen/qwen-2.5-72b-instruct:free" })), true);
});

test("parseOpenRouterCompletion returns text + usage on success", () => {
  const r = parseOpenRouterCompletion({
    choices: [{ message: { content: "hello world" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 },
  });
  assert.deepEqual(r, { text: "hello world", inTokens: 10, outTokens: 2, costUsd: 0.001 });
});

test("parseOpenRouterCompletion throws 'empty completion' when content is absent", () => {
  assert.throws(() => parseOpenRouterCompletion({ choices: [{ message: {} }] }), /empty completion/);
});

test("parseOpenRouterCompletion surfaces finish_reason on empty content", () => {
  assert.throws(
    () => parseOpenRouterCompletion({ choices: [{ message: {}, finish_reason: "length" }] }),
    /empty completion.*finish_reason=length/,
  );
});

test("parseOpenRouterCompletion surfaces a top-level OpenRouter error with its code", () => {
  assert.throws(
    () => parseOpenRouterCompletion({ error: { message: "No upstream capacity", code: "429" } }),
    /OpenRouter 429: No upstream capacity/,
  );
});

test("parseOpenRouterCompletion surfaces a per-choice error", () => {
  assert.throws(
    () => parseOpenRouterCompletion({ choices: [{ error: { message: "rate limited" } }] }),
    /OpenRouter.*rate limited/,
  );
});

test("OpenRouterProvider rejects a non-loopback http:// baseUrl at construction (#5)", () => {
  // The API key must never egress in cleartext. The guard fires at construction so it
  // covers BOTH generate() (postJson) and discover() (native fetch).
  assert.throws(
    () => new OpenRouterProvider({ apiKey: "k", baseUrl: "http://remote.example/api/v1" }),
    /OPENROUTER_BASE_URL must be https/,
  );
});

test("OpenRouterProvider allows loopback http:// and the default https baseUrl (#5)", () => {
  assert.doesNotThrow(() => new OpenRouterProvider({ apiKey: "k", baseUrl: "http://localhost:11434/api/v1" }));
  assert.doesNotThrow(() => new OpenRouterProvider({ apiKey: "k", baseUrl: "http://127.0.0.1:11434/" }));
  assert.doesNotThrow(() => new OpenRouterProvider({ apiKey: "k", baseUrl: "http://[::1]:11434/" }));
  assert.doesNotThrow(() => new OpenRouterProvider({ apiKey: "k" })); // default https://openrouter.ai
  assert.doesNotThrow(() => new OpenRouterProvider({ apiKey: "k", baseUrl: "https://openrouter.ai/api/v1" }));
});

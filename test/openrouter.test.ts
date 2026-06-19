import assert from "node:assert/strict";
import { test } from "node:test";
import { isFreeTextModel } from "../src/infrastructure/llm/openrouter.ts";

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

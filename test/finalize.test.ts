import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelPick, ModelRouterPort, ModelScore } from "../src/application/ports/model-router.ts";
import type { TransformInput } from "../src/application/ports/transformer.ts";
import { finalize } from "../src/infrastructure/llm/finalize.ts";

class RecordingRouter implements ModelRouterPort {
  readonly calls: ModelScore[] = [];
  pick(): ModelPick {
    return { provider: "none", reason: "test" };
  }
  feedback(score: ModelScore): void {
    this.calls.push(score);
  }
}

function input(mode: "summarize" | "extract", schema?: unknown): TransformInput {
  return {
    mode,
    output: mode === "extract" ? "extract" : "summary",
    content: "source",
    prompt: "p",
    schema,
  };
}

test("finalize scores once (valid:true) on a clean summary", () => {
  const router = new RecordingRouter();
  finalize(input("summarize"), "a good summary", "m", router, 10);
  assert.equal(router.calls.length, 1);
  assert.equal(router.calls[0].valid, true);
});

test("finalize scores once (valid:true) on a schema-valid extract", () => {
  const router = new RecordingRouter();
  finalize(input("extract", { type: "object", properties: { a: { type: "string" } } }), '{"a":"x"}', "m", router, 10);
  assert.equal(router.calls.length, 1);
  assert.equal(router.calls[0].valid, true);
});

test("finalize applies the mismatch penalty exactly once — no self-canceling reward", () => {
  // Regression guard: finalizeExtract penalizes (0.3, valid:false) on a schema
  // mismatch; finalize must NOT then send a valid:true reward that cancels it.
  const router = new RecordingRouter();
  const out = finalize(
    input("extract", { type: "object", properties: { a: { type: "string" } } }),
    '{"a":123}',
    "m",
    router,
    10,
  );
  assert.ok(out.schemaIssue);
  assert.equal(router.calls.length, 1, "expected only the penalty, no follow-up reward");
  assert.equal(router.calls[0].valid, false);
  assert.equal(router.calls[0].score, 0.3);
});

test("finalize fails closed (penalty once) for an unsupported schema keyword", () => {
  const router = new RecordingRouter();
  assert.throws(
    () => finalize(
      input("extract", { type: "object", properties: { a: { type: "string", format: "email" } } }),
      '{"a":"x"}',
      "m",
      router,
      10,
    ),
  );
  assert.equal(router.calls.length, 1);
  assert.equal(router.calls[0].valid, false);
  assert.equal(router.calls[0].score, 0);
});

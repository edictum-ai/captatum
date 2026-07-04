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

test("finalize records one 'success' outcome on a clean summary", () => {
  const router = new RecordingRouter();
  finalize(input("summarize"), "a good summary", "m", router);
  assert.equal(router.calls.length, 1);
  assert.equal(router.calls[0].outcome, "success");
});

test("finalize records one 'success' outcome on a schema-valid extract", () => {
  const router = new RecordingRouter();
  finalize(input("extract", { type: "object", properties: { a: { type: "string" } } }), '{"a":"x"}', "m", router);
  assert.equal(router.calls.length, 1);
  assert.equal(router.calls[0].outcome, "success");
});

test("finalize records one 'soft' outcome on a schema mismatch — no follow-up success", () => {
  // The mismatch path records 'soft' (NOT a hard failure — garbage-ish output is tolerated and
  // must not feed demotion); finalize must not then also record 'success' (one outcome per attempt).
  const router = new RecordingRouter();
  const out = finalize(
    input("extract", { type: "object", properties: { a: { type: "string" } } }),
    '{"a":123}',
    "m",
    router,
  );
  assert.ok(out.schemaIssue);
  assert.equal(router.calls.length, 1, "expected only the soft outcome, no follow-up success");
  assert.equal(router.calls[0].outcome, "soft");
});

test("finalize records one 'hard_fail' outcome (and fails closed) for an unsupported schema keyword", () => {
  const router = new RecordingRouter();
  assert.throws(
    () => finalize(
      input("extract", { type: "object", properties: { a: { type: "string", format: "email" } } }),
      '{"a":"x"}',
      "m",
      router,
    ),
  );
  assert.equal(router.calls.length, 1);
  assert.equal(router.calls[0].outcome, "hard_fail");
});

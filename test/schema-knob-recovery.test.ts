import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptatumInputError, normalizeCaptatumInput } from "../src/application/use-cases/captatum-input.ts";

test("extract schema recovery keeps a top-level false value, cleans a clone, and never changes property names", () => {
  const schema = {
    type: "object",
    allowRender: true,
    properties: { allowRender: { type: "boolean" }, budget: { type: "integer" } },
  };
  const normalized = normalizeCaptatumInput({
    url: "https://example.test/",
    output: "extract",
    allowRender: false,
    schema,
  });

  assert.equal(normalized.allowRender, false, "an explicit top-level false wins");
  assert.deepEqual(normalized.schema, {
    type: "object",
    properties: { allowRender: { type: "boolean" }, budget: { type: "integer" } },
  });
  assert.equal(schema.allowRender, true, "caller-owned schema was not mutated");
  assert.deepEqual(normalized.schemaKnobWarnings, [{
    code: "schema_knob_extracted",
    message: '"allowRender" in "schema" was ignored because the top-level Captatum tool argument takes precedence.',
  }]);
});

test("extract schema recovery applies every permitted root knob", () => {
  const normalized = normalizeCaptatumInput({
    url: "https://example.test/",
    output: "extract",
    schema: {
      type: "object",
      budget: 700,
      timeoutMs: 900,
      allowRender: false,
      debug: true,
      maxBytes: 5_000,
      transform: { provider: "ollama", model: "local" },
    },
  });

  assert.equal(normalized.budget, 700);
  assert.equal(normalized.timeoutMs, 900);
  assert.equal(normalized.allowRender, false);
  assert.equal(normalized.debug, true);
  assert.equal(normalized.maxBytes, 5_000);
  assert.deepEqual(normalized.transform, { provider: "ollama", model: "local" });
  assert.deepEqual(normalized.schema, { type: "object" });
  assert.deepEqual(normalized.schemaKnobWarnings.map((warning) => warning.code), Array(6).fill("schema_knob_extracted"));
});

test("extract schema recovery reuses field validation and leaves invalid values fail-closed", () => {
  assert.throws(
    () => normalizeCaptatumInput({
      url: "https://example.test/",
      output: "extract",
      schema: { type: "object", budget: "700" },
    }),
    (error: unknown) => error instanceof CaptatumInputError && error.body.error.code === "extract_schema_unsupported_keyword",
  );
});

test("extract schema recovery cleans known knobs before rejecting a genuine unsupported keyword", () => {
  assert.throws(
    () => normalizeCaptatumInput({
      url: "https://example.test/",
      output: "extract",
      schema: { type: "object", budget: 700, format: "email" },
    }),
    (error: unknown) => error instanceof CaptatumInputError && error.body.error.code === "extract_schema_unsupported_keyword" && /format/.test(error.message),
  );
});

test("extract schema recovery never accepts an egress or output selector", () => {
  assert.throws(
    () => normalizeCaptatumInput({
      url: "https://example.test/",
      output: "extract",
      schema: { type: "object", output: "raw" },
    }),
    (error: unknown) => error instanceof CaptatumInputError && error.body.error.code === "extract_schema_unsupported_keyword",
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateJsonSchema } from "../src/infrastructure/llm/json-schema.ts";

// PR 8: JSON-Schema validation correctness. The `in` operator walks the prototype
// chain, so own `constructor`/`toString` keys were masked by inherited ones and
// slipped past additionalProperties:false / required; and JSON.stringify-based
// deep equality treated reordered-key objects as distinct, weakening
// uniqueItems/enum/const.

test("additionalProperties:false rejects an own constructor/toString key (not masked by the inherited one)", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    additionalProperties: false,
  };
  assert.equal(validateJsonSchema({ name: "x", constructor: "evil" }, schema).valid, false);
  assert.equal(validateJsonSchema({ name: "x", toString: "evil" }, schema).valid, false);
  assert.equal(validateJsonSchema({ name: "x" }, schema).valid, true);
});

test("uniqueItems rejects duplicate objects whose keys are in a different order", () => {
  const schema = { type: "array", uniqueItems: true };
  assert.equal(validateJsonSchema([{ a: 1, b: 2 }, { b: 2, a: 1 }], schema).valid, false);
  assert.equal(validateJsonSchema([{ a: 1, b: 2 }, { a: 1, b: 3 }], schema).valid, true);
});

test("enum/const treat reordered-key objects as equal (canonical deep equality)", () => {
  assert.equal(validateJsonSchema({ b: 2, a: 1 }, { enum: [{ a: 1, b: 2 }] }).valid, true);
  assert.equal(validateJsonSchema({ b: 2, a: 1 }, { const: { a: 1, b: 2 } }).valid, true);
});

test("required checks own properties, not inherited ones", () => {
  const schema = { type: "object", required: ["constructor"] };
  // `constructor` exists on the prototype but not as an own property of {}.
  assert.equal(validateJsonSchema({ name: "x" }, schema).valid, false);
});

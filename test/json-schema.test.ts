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

test("schema pattern with nested quantifiers is rejected as unsupported (TRANSFORM-2)", () => {
  const r = validateJsonSchema("aaa", { pattern: "^(a+)+$" });
  assert.equal(r.valid, false);
  assert.equal(r.unsupported, true, "catastrophic pattern must be rejected as unsupported");
});

test("schema pattern with wrapped nested quantifiers is rejected (TRANSFORM-2)", () => {
  // ((a+))+ — the inner group's quantifier propagates to the enclosing group.
  assert.equal(validateJsonSchema("aaa", { pattern: "^((a+))+$" }).unsupported, true);
});

test("schema pattern with duplicate- or prefix-overlap alternation is rejected (TRANSFORM-2)", () => {
  // (a|a)+ exact-duplicate overlap and (a|aa)+ / (a|ab)+ prefix-overlap: distinct
  // branches that can both match the same input, so a quantifier backtracks hard.
  assert.equal(validateJsonSchema("aaa", { pattern: "^(a|a)+$" }).unsupported, true);
  assert.equal(validateJsonSchema("aaa", { pattern: "^(a|aa)+$" }).unsupported, true);
  assert.equal(validateJsonSchema("aab", { pattern: "^(a|ab)+$" }).unsupported, true);
  // wrapped overlap ((a|a))+ — the inner overlap must propagate to the outer quantifier.
  assert.equal(validateJsonSchema("aaa", { pattern: "^((a|a))+$" }).unsupported, true);
  // disjoint alternation (a|b)+ is safe and must NOT be rejected.
  assert.equal(validateJsonSchema("ab", { pattern: "^(a|b)+$" }).unsupported, undefined);
});

test("schema pattern with a quantified group that is NOT repeated stays valid (TRANSFORM-2 FP guard)", () => {
  // ([0-9]+) contains a quantifier but is not itself quantified -> safe.
  const r = validateJsonSchema("123", { pattern: "^([0-9]+)$" });
  assert.equal(r.valid, true);
  assert.notEqual(r.unsupported, true);
});

test("schema pattern on a value over the 8 KiB cap surfaces as unverified, not silently accepted", () => {
  const r = validateJsonSchema("a".repeat(9000) + "!", { pattern: "^[a]+$" });
  assert.equal(r.valid, false);
  assert.match(r.message ?? "", /8 KiB pattern-validation cap/);
});

test("schema pattern exceeding the length cap is rejected (TRANSFORM-2)", () => {
  assert.equal(validateJsonSchema("x", { pattern: "a".repeat(200) }).valid, false);
});

test("a normal schema pattern still validates (TRANSFORM-2 regression)", () => {
  assert.equal(validateJsonSchema("12345", { pattern: "^\\d+$" }).valid, true);
  assert.equal(validateJsonSchema("abc", { pattern: "^\\d+$" }).valid, false);
});

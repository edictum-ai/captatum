import assert from "node:assert/strict";
import { test } from "node:test";
import { validateJsonSchema } from "../src/infrastructure/llm/json-schema.ts";
import { findUnsupportedSchemaKeyword, MAX_SCHEMA_BYTES, MAX_SCHEMA_DEPTH, MAX_SCHEMA_NODES, schemaByteSize, SUPPORTED_KEYS, unsupportedKeywordMessage } from "../src/infrastructure/llm/schema-keywords.ts";

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

// #153: input-boundary keyword allowlist scan. The caller extract schema is untrusted input;
// the scan is an ALLOWLIST (SUPPORTED_KEYS), iterative + visited-set + node-capped so a
// huge/cyclic/deep caller schema cannot stack-overflow or stall the event loop, and the
// message leads with the offending key so `$` + `schema` never visually merges into `$schema`.

test("findUnsupportedSchemaKeyword: $schema is a SUPPORTED key (not flagged) — the #153 offender was a sibling key", () => {
  assert.equal(SUPPORTED_KEYS.has("$schema"), true);
  assert.deepEqual(findUnsupportedSchemaKeyword({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }), { ok: true });
});

test("findUnsupportedSchemaKeyword: flags a top-level unsupported key with the $ path", () => {
  assert.deepEqual(findUnsupportedSchemaKeyword({ type: "object", budget: 8000 }), { ok: false, kind: "unsupported", key: "budget", path: "$" });
});

test("findUnsupportedSchemaKeyword: recurses into properties/items/additionalProperties/composites/$defs naming the nested path", () => {
  assert.deepEqual(findUnsupportedSchemaKeyword({ properties: { a: { format: "email" } } }), { ok: false, kind: "unsupported", key: "format", path: "$.properties.a" });
  assert.deepEqual(findUnsupportedSchemaKeyword({ items: { format: "email" } }), { ok: false, kind: "unsupported", key: "format", path: "$.items" });
  assert.deepEqual(findUnsupportedSchemaKeyword({ additionalProperties: { format: "email" } }), { ok: false, kind: "unsupported", key: "format", path: "$.additionalProperties" });
  assert.deepEqual(findUnsupportedSchemaKeyword({ not: { format: "email" } }), { ok: false, kind: "unsupported", key: "format", path: "$.not" });
  assert.deepEqual(findUnsupportedSchemaKeyword({ anyOf: [{ type: "string" }, { format: "email" }] }), { ok: false, kind: "unsupported", key: "format", path: "$.anyOf[1]" });
  assert.deepEqual(findUnsupportedSchemaKeyword({ $defs: { Foo: { format: "email" } } }), { ok: false, kind: "unsupported", key: "format", path: "$.$defs.Foo" });
});

test("findUnsupportedSchemaKeyword: boolean schemas (true/false) are valid", () => {
  assert.deepEqual(findUnsupportedSchemaKeyword(true), { ok: true });
  assert.deepEqual(findUnsupportedSchemaKeyword(false), { ok: true });
});

test("findUnsupportedSchemaKeyword: malformed (non-object, non-boolean) schema fails closed with the path", () => {
  assert.deepEqual(findUnsupportedSchemaKeyword(42), { ok: false, kind: "malformed", path: "$" });
  assert.deepEqual(findUnsupportedSchemaKeyword("not a schema"), { ok: false, kind: "malformed", path: "$" });
  assert.deepEqual(findUnsupportedSchemaKeyword([1, 2, 3]), { ok: false, kind: "malformed", path: "$" });
  // a nested malformed node names its own path
  assert.deepEqual(findUnsupportedSchemaKeyword({ properties: { x: 7 } }), { ok: false, kind: "malformed", path: "$.properties.x" });
});

test("findUnsupportedSchemaKeyword: a cyclic object reference terminates (visited-set), no infinite loop", () => {
  const cyclic: Record<string, unknown> = { type: "object", properties: {} };
  cyclic.properties = { self: cyclic }; // self-reference via a supported key
  assert.deepEqual(findUnsupportedSchemaKeyword(cyclic), { ok: true });
});

test("findUnsupportedSchemaKeyword: a pathologically DEEP schema hits the depth cap (too_large), not a stack overflow", () => {
  // Deep but all-supported + few nodes: passes the node cap, would stack-overflow the recursive
  // value validator. The scan's depth cap rejects it fail-fast at the boundary.
  let schema: unknown = { type: "string" };
  for (let i = 0; i < MAX_SCHEMA_NODES + 50; i += 1) schema = { type: "object", properties: { a: schema } };
  const r = findUnsupportedSchemaKeyword(schema);
  assert.equal(r.ok, false);
  assert.equal((r as { kind: string }).kind, "too_large");
});

test("findUnsupportedSchemaKeyword: a huge but SHALLOW schema hits the node cap (too_large)", () => {
  // >MAX_SCHEMA_NODES sibling properties (depth 2) — the node cap, not the depth cap, fires.
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < MAX_SCHEMA_NODES + 10; i += 1) properties[`k${i}`] = { type: "string" };
  const r = findUnsupportedSchemaKeyword({ type: "object", properties });
  assert.equal(r.ok, false);
  assert.equal((r as { kind: string }).kind, "too_large");
});

test("findUnsupportedSchemaKeyword: tuple (array-valued) items are an unsupported value-form (#153)", () => {
  // `items` is a supported KEY, but a tuple (array) value can't be positionally validated; the
  // scan rejects it at the boundary so it doesn't pass fail-fast then advisory-after-LLM.
  assert.deepEqual(findUnsupportedSchemaKeyword({ type: "array", items: [{ type: "string" }, { type: "number" }] }), { ok: false, kind: "unsupported_value", key: "items", path: "$" });
  // A single-schema (object) items is fine.
  assert.deepEqual(findUnsupportedSchemaKeyword({ type: "array", items: { type: "string" } }), { ok: true });
});

test("findUnsupportedSchemaKeyword: a scalar/wrong-type schema-valued keyword is malformed (#153 codex P2)", () => {
  // A scalar (non-boolean/non-object) items/additionalProperties/not must be rejected at the
  // boundary, not silently ignored (else it fetches+LLMs and is accepted for an empty array).
  assert.deepEqual(findUnsupportedSchemaKeyword({ items: 42 }), { ok: false, kind: "malformed", path: "$.items" });
  assert.deepEqual(findUnsupportedSchemaKeyword({ additionalProperties: "no" }), { ok: false, kind: "malformed", path: "$.additionalProperties" });
  assert.deepEqual(findUnsupportedSchemaKeyword({ not: null }), { ok: false, kind: "malformed", path: "$.not" });
  // Boolean forms of these single-schema keys ARE valid.
  assert.deepEqual(findUnsupportedSchemaKeyword({ items: true, additionalProperties: false, not: { type: "string" } }), { ok: true });
  // Wrong container type for the map/array keywords is malformed too.
  assert.deepEqual(findUnsupportedSchemaKeyword({ properties: 42 }), { ok: false, kind: "malformed", path: "$.properties" });
  assert.deepEqual(findUnsupportedSchemaKeyword({ allOf: "x" }), { ok: false, kind: "malformed", path: "$.allOf" });
  assert.deepEqual(findUnsupportedSchemaKeyword({ $defs: 1 }), { ok: false, kind: "malformed", path: "$.$defs" });
});

test("findUnsupportedSchemaKeyword: depth cap is aligned with the value validator (rejects at MAX_SCHEMA_DEPTH, root=0)", () => {
  // codex P2: the boundary must reject at the SAME depth validateAt does (validateAt counts the
  // root in stack.size). depth >= MAX_SCHEMA_DEPTH (root=0) matches validateAt's stack.size > cap.
  const build = (n: number): unknown => { let s: unknown = { type: "object" }; for (let i = 0; i < n; i += 1) s = { properties: { a: s } }; return s; };
  assert.equal(findUnsupportedSchemaKeyword(build(MAX_SCHEMA_DEPTH - 1)).ok, true, "depth cap-1 passes the boundary");
  const at = findUnsupportedSchemaKeyword(build(MAX_SCHEMA_DEPTH));
  assert.equal(at.ok, false);
  assert.equal((at as { kind: string }).kind, "too_large", "depth cap rejects, aligned with validateAt");
});

test("findUnsupportedSchemaKeyword: a valid rich schema scans clean", () => {
  assert.deepEqual(findUnsupportedSchemaKeyword({
    type: "object",
    required: ["title"],
    properties: { title: { type: "string", minLength: 3, maxLength: 100 }, tags: { type: "array", items: { type: "string" }, uniqueItems: true } },
    additionalProperties: false,
  }), { ok: true });
});

test("unsupportedKeywordMessage leads with the quoted key, then the path — no `$schema` visual merge (#153)", () => {
  assert.equal(unsupportedKeywordMessage("budget", "$"), 'Unsupported JSON Schema keyword "budget" at $ — captatum cannot verify it; remove it.');
  assert.equal(unsupportedKeywordMessage("format", "$.properties.email"), 'Unsupported JSON Schema keyword "format" at $.properties.email — captatum cannot verify it; remove it.');
});

test("value-validator backstop: an unsupported keyword fails closed with the key-leading message (#153)", () => {
  // Defense-in-depth: finalize's value-validator still rejects unsupported keywords (for paths
  // that bypass the input check) using the same key-leading message as the input reject.
  const r = validateJsonSchema({ title: "x" }, { type: "object", properties: { title: { type: "string", format: "email" } } });
  assert.equal(r.valid, false);
  assert.equal(r.unsupported, true);
  assert.equal(r.message, 'Unsupported JSON Schema keyword "format" at $.title — captatum cannot verify it; remove it.');
});

test("value-validator backstop: a pathologically deep schema fails closed at the depth bound, not a stack overflow (#153 P1)", () => {
  // Defense-in-depth: even if a path bypassed the input scan, the recursive value validator is
  // depth-bounded (MAX_SCHEMA_DEPTH) — it returns unsupported instead of stack-overflowing.
  let deep: unknown = { type: "object" };
  for (let i = 0; i < 300; i += 1) deep = { allOf: [deep] };
  const r = validateJsonSchema({}, deep);
  assert.equal(r.valid, false);
  assert.equal(r.unsupported, true);
  assert.match(r.message ?? "", /nesting exceeds the \d+-level validation depth/);
});

test("schemaByteSize: measures payload (not just structure) and early-exits past the cap (#153 codex P2)", () => {
  // A small schema measures a positive, finite size (roughly its JSON length).
  const small = schemaByteSize({ type: "object", properties: { a: { type: "string" } } }, 1_000_000);
  assert.ok(small > 0 && small < 1_000_000);
  // A ONE-node schema with a huge terminal value: the node/depth caps miss it (1 node, depth 1);
  // the byte cap catches it because payload, not structure, is what inflates the transform prompt.
  const hugeDescription = { type: "object", description: "x".repeat(MAX_SCHEMA_BYTES + 1000) };
  assert.ok(schemaByteSize(hugeDescription, MAX_SCHEMA_BYTES) > MAX_SCHEMA_BYTES, "a huge terminal value exceeds the byte cap");
  // A huge enum array of primitives likewise.
  const hugeEnum = { type: "string", enum: Array.from({ length: 20_000 }, (_, i) => `code-${i}`) };
  assert.ok(schemaByteSize(hugeEnum, MAX_SCHEMA_BYTES) > MAX_SCHEMA_BYTES, "a huge enum exceeds the byte cap");
  // early-exit: measuring a 1 MB schema against the small cap returns > cap without walking it all.
  const mega = { description: "y".repeat(1_000_000) };
  assert.ok(schemaByteSize(mega, MAX_SCHEMA_BYTES) > MAX_SCHEMA_BYTES);
});

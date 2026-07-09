// FROZEN acceptance suite for #153 — Extract schema input-validation (input boundary).
// Authored INDEPENDENTLY of the implementation, purely from the spec + the repo's public
// source signatures. These tests assert the DESIRED post-implementation behavior at the
// untrusted-schema trust boundary (caller-supplied JSON Schema for output:"extract").
// They WILL FAIL against the current code (no input-time allowlist check; message visual-
// merges "$ schema keyword"; no depth cap) — that is intended. The suite is hash-frozen
// after authoring; the implementer CANNOT edit these (only activate phase 153).
//
// Spec: docs/specs/153-extract-schema-input-validation.md — covers criteria C1, C2, C3, C4, C7.
//
// Scope: this file covers the INPUT-BOUNDARY fail-fast behavior (the new
// src/domain/schema-allowlist.ts walker + its use in normalizeCaptatumInput /
// normalizeBulkInput, before any fetch). The receipt-enrichment criteria (C5/C6/C8/C9)
// live in receipt.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findUnsupportedSchemaKeyword,
  messageForUnsupportedKeyword,
  MAX_SCHEMA_DEPTH,
} from "../../../src/domain/schema-allowlist.ts";
import {
  CaptatumInputError,
  normalizeCaptatumInput,
} from "../../../src/application/use-cases/captatum-input.ts";
import { normalizeBulkInput } from "../../../src/application/use-cases/bulk-input.ts";
import { createCaptatumUseCase } from "../../../src/application/use-cases/captatum.ts";
import type { FetcherPort } from "../../../src/application/ports/fetcher.ts";
import { PlatformAdapterRegistry, type PlatformAdapter } from "../../../src/application/ports/platform-adapter.ts";

/** Run `fn` and return the CaptatumInputError it must throw (fails loudly otherwise). */
function captureInputError(fn: () => unknown): CaptatumInputError {
  try {
    fn();
  } catch (err) {
    if (err instanceof CaptatumInputError) return err;
    throw err;
  }
  throw new Error("expected CaptatumInputError, but nothing was thrown");
}

/** A FetcherPort that records any egress attempt and throws if reached. The real port's
 *  only method is `fetchGuarded(url, opts, postInit?)` (src/application/ports/fetcher.ts). */
function recordingFetcher(): { port: FetcherPort; wasCalled: () => boolean } {
  let called = false;
  const port: FetcherPort = {
    async fetchGuarded() {
      called = true;
      throw new Error("MUST NOT FETCH — schema validation must run before any egress");
    },
  };
  return { port, called: () => called };
}

// --- C1: message clarity. The offending key leads; the path is visually separate; the
//     pre-fix "$ schema keyword" visual-merge bug (eye reads it as "$schema keyword") is gone. ---

test("C1: budget at the root is reported; the message leads with the offending key", () => {
  const finding = findUnsupportedSchemaKeyword({
    type: "object",
    properties: { a: { type: "string" } },
    budget: 1,
  });
  assert.deepEqual(finding, { kind: "unsupported", key: "budget", path: "$" });

  const message = messageForUnsupportedKeyword("budget", "$");
  assert.equal(
    message,
    'Unsupported JSON Schema keyword "budget" at $ — captatum cannot verify it; remove it.',
  );
  assert.ok(
    message.startsWith('Unsupported JSON Schema keyword "budget"'),
    "message leads with the offending key",
  );
  // The pre-fix message rendered `$ schema keyword "budget"`, which the eye merges into
  // `$schema keyword "budget"` — implicating the SUPPORTED `$schema` key. The new message
  // must not contain either form.
  assert.ok(!message.includes("$schema keyword"), "must not visually merge into '$schema keyword'");
  assert.ok(!message.includes("$ schema keyword"), "must not echo the pre-fix '$ schema keyword' form");
});

test("C1: a $schema-only schema is accepted (no finding)", () => {
  // $schema is a SUPPORTED key; a schema declaring only it (+ type) must pass the allowlist.
  const finding = findUnsupportedSchemaKeyword({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
  });
  assert.equal(finding, undefined);
});

// --- C3: a nested unsupported keyword is reported with its JSON-pointer-ish path. ---

test("C3: an unsupported keyword nested in properties.email is reported at $.properties.email", () => {
  const schema = {
    type: "object",
    properties: { email: { type: "string", format: "email" } },
  };
  const finding = findUnsupportedSchemaKeyword(schema);
  assert.deepEqual(finding, { kind: "unsupported", key: "format", path: "$.properties.email" });

  const err = captureInputError(() =>
    normalizeCaptatumInput({ url: "https://x.test/", output: "extract", schema }),
  );
  assert.equal(err.body.error.code, "extract_schema_unsupported_keyword");
  assert.match(err.body.error.message, /"format"/, "the offending key 'format' is named");
  assert.match(err.body.error.message, /\$\.properties\.email/, "the nested path is rendered");
});

// --- C2: input fail-fast at the execute() boundary — ZERO fetcher invocations. ---

test("C2 (unit): normalizeCaptatumInput throws extract_schema_unsupported_keyword before any fetch", () => {
  const err = captureInputError(() =>
    normalizeCaptatumInput({
      url: "https://x.test/",
      output: "extract",
      schema: { type: "object", properties: { a: { type: "string" } }, budget: 1 },
    }),
  );
  assert.equal(err.body.error.code, "extract_schema_unsupported_keyword");
});

test("C2 (unit): a supported-keyword extract schema is accepted by normalizeCaptatumInput", () => {
  const supported = {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
  };
  const normalized = normalizeCaptatumInput({
    url: "https://x.test/",
    output: "extract",
    schema: supported,
  });
  assert.equal(normalized.requestedOutput, "extract");
  assert.deepEqual(normalized.schema, supported);
});

test("C2: CaptatumUseCase.execute with an unsupported-keyword schema throws before any fetch or Tier-2 adapter call", async () => {
  // Honest proof of "before any fetch": a fail-on-call fetcher whose flag must stay false, AND a
  // Tier-2 spy adapter whose detect() throws if reached. normalizeCaptatumInput is the first
  // statement of execute() (captatum.ts), so neither the Tier-2 adapter short-circuit nor the
  // Tier-1 guarded fetch is reached. If a regression moved Tier-2 before normalize, the spy's
  // plain Error would surface here — assert.rejects would fail its CaptatumInputError matcher.
  const spyAdapter: PlatformAdapter = {
    id: "tier2-spy",
    detect: () => { throw new Error("MUST NOT REACH TIER-2 — input validation must run first"); },
    resolve: async () => { throw new Error("MUST NOT RESOLVE — input validation must run first"); },
  };
  const { port: fetcher, called: fetcherCalled } = recordingFetcher();
  const useCase = createCaptatumUseCase({
    fetcher,
    extractHtml: () => {
      throw new Error("MUST NOT EXTRACT — input validation must run first");
    },
    adapters: new PlatformAdapterRegistry([spyAdapter]),
    clock: { nowMs: () => 0 },
  });

  await assert.rejects(
    useCase.execute({
      url: "https://x.test/",
      output: "extract",
      schema: { type: "object", properties: { a: { type: "string" } }, budget: 1 },
    }),
    (err: unknown): boolean =>
      err instanceof CaptatumInputError &&
      err.body.error.code === "extract_schema_unsupported_keyword",
    "execute() rejects with the input-validation error",
  );

  assert.equal(
    fetcherCalled(),
    false,
    "zero fetcher invocations — schema validated at the input boundary before any egress",
  );
});

// --- C4: bulk fail-fast — a bad UNIFORM schema rejects the whole call before any seed. ---

test("C4: normalizeBulkInput throws extract_schema_unsupported_keyword for a uniform bad schema", () => {
  // A bad uniform schema would otherwise waste N fetches; it is a whole-call (tool-level)
  // reject, thrown before any seed is processed (same severity as too_many_urls).
  const err = captureInputError(() =>
    normalizeBulkInput({
      urls: ["https://x.test/"],
      output: "extract",
      schema: { type: "object", budget: 1 },
    }),
  );
  assert.equal(err.body.error.code, "extract_schema_unsupported_keyword");
});

// --- C7: depth cap. The boundary is pinned at MAX_SCHEMA_DEPTH: a schema AT the cap is accepted,
//     one PAST it fails closed (extract_schema_too_deep). Matches the walker's depth > MAX
//     semantics and self-aligns with the constant — if the cap changes, both cases track it. ---

/** Build a schema with `levels` nested `properties.a` wrappings (all SUPPORTED keywords).
 *  Each level is one applied-subschema recursion for the walker. */
function nestedSchema(levels: number): unknown {
  let node: unknown = { type: "string" };
  for (let i = 0; i < levels; i += 1) {
    node = { type: "object", properties: { a: node } };
  }
  return node;
}

test("C7: MAX_SCHEMA_DEPTH constant is 64 (spec-pinned depth cap)", () => {
  // Pin the contract via the constant. The boundary cases below pin at MAX_SCHEMA_DEPTH itself
  // (within) and MAX_SCHEMA_DEPTH + 1 (over) — self-aligning with the constant so a future cap
  // change moves both with it, matching the walker's depth > MAX rejection semantics.
  assert.equal(MAX_SCHEMA_DEPTH, 64, "spec: depth cap constant is 64");
});

test("C7: a schema nested MAX_SCHEMA_DEPTH (64) levels (all supported keywords) is accepted", () => {
  // The boundary is pinned at MAX_SCHEMA_DEPTH: nestedSchema(MAX_SCHEMA_DEPTH) has its deepest node
  // AT exactly the cap and is accepted (the walker rejects only when depth > MAX). Self-aligns with
  // the constant — if the cap changes, this case tracks it.
  const within = nestedSchema(MAX_SCHEMA_DEPTH);
  assert.equal(findUnsupportedSchemaKeyword(within), undefined);
  // normalizeCaptatumInput must NOT throw for a schema exactly at the depth cap (proves fail-open
  // at the boundary, not fail-closed one shy of it).
  const normalized = normalizeCaptatumInput({
    url: "https://x.test/",
    output: "extract",
    schema: within,
  });
  assert.equal(normalized.requestedOutput, "extract");
});

test("C7: a schema nested MAX_SCHEMA_DEPTH + 1 (65) levels is rejected as too_deep", () => {
  // The boundary is pinned at MAX_SCHEMA_DEPTH: nestedSchema(MAX_SCHEMA_DEPTH + 1) is ONE PAST the
  // cap and is rejected (the walker rejects when depth > MAX). Self-aligns with the constant.
  const over = nestedSchema(MAX_SCHEMA_DEPTH + 1);
  assert.equal(findUnsupportedSchemaKeyword(over)?.kind, "too_deep");

  const err = captureInputError(() =>
    normalizeCaptatumInput({
      url: "https://x.test/",
      output: "extract",
      schema: over,
    }),
  );
  assert.equal(err.body.error.code, "extract_schema_too_deep");
});

// --- C7b: tuple-form items fail-closed. The value validator only ADVISORIES tuple arrays (invalid,
//     unsupported unset → finalize returns parsed JSON + a schemaIssue), so the walker must
//     hard-reject the unverifiable form at input (extract_schema_tuple_unsupported). ---

test("C7b: tuple-form items are fail-closed at input (the value validator only advisories tuples)", () => {
  const tupleSchema = { type: "array", items: [{ type: "string", format: "email" }] };
  const finding = findUnsupportedSchemaKeyword(tupleSchema);
  assert.equal(finding?.kind, "tuple_items");
  assert.equal(finding?.path, "$.items");

  const err = captureInputError(() =>
    normalizeCaptatumInput({ url: "https://x.test/", output: "extract", schema: tupleSchema }),
  );
  assert.equal(err.body.error.code, "extract_schema_tuple_unsupported");
});

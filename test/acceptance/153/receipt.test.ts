// FROZEN acceptance suite for #153 — Extract schema validation: receipt enrichment.
// Authored INDEPENDENTLY of the implementation, purely from the spec + public source signatures.
// Asserts the DESIRED post-implementation agent-facing receipt: outputRequested (requested vs
// actual output), the typed TransformReason union, the provider:"none" ⇒ status "partial"
// conformance fix, and the retained defense-in-depth throw at the finalize() transform seam.
// These WILL FAIL against current code — intended. Hash-frozen after authoring; activate phase 153.
// Spec: docs/specs/153-extract-schema-input-validation.md — criteria C5, C6, C8, C9.
// Input-boundary fail-fast criteria (C1-C4/C7) live in input-validation.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStructuredContent } from "../../../src/interfaces/mcp/shape.ts";
import { finalize } from "../../../src/infrastructure/llm/finalize.ts";
import { TransformError, type TransformInput, type TransformPort } from "../../../src/application/ports/transformer.ts";
import type { ModelRouterPort } from "../../../src/application/ports/model-router.ts";
import type { Result } from "../../../src/domain/result.ts";
import { createCaptatumUseCase } from "../../../src/application/use-cases/captatum.ts";
import type { FetcherPort, FetcherResult } from "../../../src/application/ports/fetcher.ts";
import { PlatformAdapterRegistry } from "../../../src/application/ports/platform-adapter.ts";
import type { HtmlExtraction, HtmlExtractionInput } from "../../../src/application/use-cases/tier1-extract.ts";
import { bulkSeedStatus } from "../../../src/application/use-cases/bulk-seed.ts";

/** A complete, realistic Tier-1 Result with `overrides` applied. buildStructuredContent
 *  reads many fields (classifyStatus/Access/ContentType, redactSignedQueryParams, snippet),
 *  so the base is a valid happy-path Result and each case only flips output/transform/etc. */
function baseResult(overrides: Partial<Result>): Result {
  return {
    url: "https://x.test/",
    bytes: 100,
    code: 200,
    codeText: "OK",
    durationMs: 10,
    result: "Some real page content that is non-empty so hasContent() is true.",
    schemaVersion: 1,
    finalUrl: "https://x.test/",
    redirects: [],
    tier: 1,
    output: "raw",
    platform: { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier1" },
    jsRequired: false,
    resolvedVia: "tier1-meta",
    attempts: [{ step: 1, tier: 1, outcome: "ok", status: 200, durationMs: 8, bytes: 100, reason: "content-present" }],
    contentType: "text/html; charset=utf-8",
    timings: { totalMs: 10, fetchMs: 8 },
    errors: [],
    ...overrides,
  };
}

// --- C5: outputRequested on a degrade. A summary requested but degraded to raw carries
//     outputRequested:"summary" + output:"raw", surfaced in the lean receipt. ---

test("C5: a degraded summary→raw surfaces outputRequested:'summary' in the lean receipt", () => {
  const result = baseResult({
    output: "raw",
    outputRequested: "summary",
    transform: { provider: "none", reason: "unconfigured" },
  });
  const lean = buildStructuredContent(result, false);
  assert.equal(lean.outputRequested, "summary", "lean surfaces what the caller REQUESTED");
  assert.equal(lean.output, "raw", "output reflects the ACTUAL post-degrade mode");
  assert.equal(lean.status, "partial", "a provider:none degrade is partial");
});

// --- C5 (execute): the existing C5 pre-populates `outputRequested` in the fixture, so it only
//     proves buildStructuredContent FORWARDS the field. This drives a summary→raw degrade through
//     execute() and asserts applyOutputMode STAMPS outputRequested itself. ---

test("C5 (execute): a summary→raw degrade stamps outputRequested on the result (not just forwarded by shape)", async () => {
  const text = "Some real page content for the no-transformer degrade path.";
  const b = new TextEncoder().encode(`<main>${text}</main>`);
  const fetcher: FetcherPort = {
    async fetchGuarded(): Promise<FetcherResult> {
      return {
        status: 200, finalUrl: "https://x.test/", redirects: [],
        bodyStream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(b); c.close(); } }),
        contentType: "text/html; charset=utf-8", bytes: b.byteLength,
      };
    },
  };
  const extractHtml = (_input: HtmlExtractionInput): HtmlExtraction => ({
    text, structured: {},
    shellGate: { jsRequired: false, reason: "content-present", textLength: text.length,
      wordCount: text.split(/\s+/).length, scriptCount: 0, appRootFound: false, structuredDataFound: false },
    errors: [],
  });
  // NO transformer ⇒ a summary request degrades to raw (provider:"none", reason:"unconfigured").
  const useCase = createCaptatumUseCase({ fetcher, extractHtml, adapters: new PlatformAdapterRegistry([]), clock: { nowMs: () => 0 } });
  const result = await useCase.execute({ url: "https://x.test/", output: "summary" });
  assert.equal(result.outputRequested, "summary", "applyOutputMode stamps outputRequested");
  assert.equal(result.output, "raw", "the summary degrade returns raw");
  assert.equal(result.transform?.provider, "none");
});

// --- C9: outputRequested on a SUCCESS (non-degrade path). A completed summary carries
//     outputRequested:"summary"; success never sets a transform.reason. ---

test("C9: a successful summary carries outputRequested:'summary'", () => {
  const result = baseResult({
    output: "summary",
    outputRequested: "summary",
    transform: { provider: "openrouter", model: "some-model", inTokens: 10, outTokens: 5 },
  });
  const lean = buildStructuredContent(result, false);
  assert.equal(lean.outputRequested, "summary");
  assert.equal(lean.status, "pass", "a real summary is a pass, not a degrade");
});

// --- C6: typed reason + status conformance fix. Any provider:"none" ⇒ status "partial"
//     (the old brittle reason allowlist — "failed" || "unconfigured" — under-reported router
//     sub-reasons and would break under the "failed"→"transform_failed" rename). ---

test("C6: transform_failed + provider:none ⇒ status partial", () => {
  // The renamed degrade reason ("failed" → "transform_failed") must still classify as partial.
  const result = baseResult({
    output: "raw",
    transform: { provider: "none", reason: "transform_failed" },
  });
  assert.equal(buildStructuredContent(result, false).status, "partial");
});

test("C6 (conformance): no_model_fit + provider:none ⇒ status partial", () => {
  // Pre-fix classifyStatus only treated reason "failed"/"unconfigured" as partial, so a router
  // sub-reason like no_model_fit mislabeled status "pass". The fix: provider:"none" ⇒ partial
  // for ANY reason. This case fails against the current reason allowlist — that is the point.
  const result = baseResult({
    output: "raw",
    transform: { provider: "none", reason: "no_model_fit" },
  });
  assert.equal(buildStructuredContent(result, false).status, "partial");
});

test("C6: a real (non-none) transform ⇒ status pass", () => {
  const result = baseResult({
    output: "summary",
    transform: { provider: "openrouter", model: "m" },
  });
  assert.equal(buildStructuredContent(result, false).status, "pass");
});

// --- C6 (bulk): the same provider:"none" ⇒ "partial" contract change applies to the bulk seed
//     classifier `bulkSeedStatus` (the sibling in src/application/use-cases/bulk-seed.ts). Pre-fix
//     it used the brittle reason allowlist ("failed"/"unconfigured") and mislabeled every router
//     sub-reason as "pass"; the conformance fix simplifies it to provider:"none" ⇒ partial. ---

test("C6 (bulk): bulkSeedStatus classifies any provider:none degrade as partial (the bulk-seed sibling conformance fix)", () => {
  // A router sub-reason (not just "failed"/"unconfigured") must classify partial.
  assert.equal(bulkSeedStatus(baseResult({ output: "raw", transform: { provider: "none", reason: "no_model_fit" } })), "partial");
  // The renamed degrade reason ("failed" → "transform_failed") must also classify partial.
  assert.equal(bulkSeedStatus(baseResult({ output: "raw", transform: { provider: "none", reason: "transform_failed" } })), "partial");
  // A clean (non-none) transform stays a pass.
  assert.equal(bulkSeedStatus(baseResult({ output: "summary", transform: { provider: "openrouter", model: "m" } })), "pass");
});

// --- C8: finalize() defense-in-depth. The input-boundary check rejects unsupported keywords
//  BEFORE any fetch, so this unsupported-keyword branch is DEAD in the production call graph
//  (only TransformPort caller is captatum.ts). It is RETAINED for a hypothetical direct-TransformPort
//  caller and must still FAIL CLOSED. It throws TransformError(code:"extract_schema_invalid"); the
//  degrade REASON "schema_validation_failed" is set by captatum.ts's applyOutputMode() catch (which
//  maps that code), unreachable through execute() (normalize throws first) — pinned by the test below. ---

test("C8: finalize() fails closed (throws) on an unsupported-keyword schema", () => {
  const fakeRouter: ModelRouterPort = {
    pick: () => ({ provider: "openrouter", model: "m" }),
    feedback: () => {
      // finalize records a "hard_fail" outcome before throwing; a no-op fake is sufficient.
    },
  };
  const input: TransformInput = {
    mode: "extract",
    output: "extract",
    content: '{"a":"x"}',
    prompt: "extract",
    schema: { type: "object", properties: { a: { type: "string", format: "email" } } },
  };

  assert.throws(
    () => finalize(input, '{"a":"x"}', "m", fakeRouter),
    (err: unknown): boolean =>
      err instanceof TransformError && err.code === "extract_schema_invalid",
    "finalize() must fail closed with the code the captatum.ts catch maps to schema_validation_failed",
  );
});

// --- C8 (execute-level reason mapping): pins at the execute() seam that captatum.ts's
//  applyOutputMode() catch maps a thrown extract_schema_invalid code → degrade reason
//  "schema_validation_failed" (any other thrown code → "transform_failed"). A VALID extract schema
//  (so normalize does NOT throw) + a fake fetcher 200 + a transformer whose transform() rejects
//  with TransformError("extract_schema_invalid"). Fails on CURRENT code (catch hardcodes "failed"). ---

test("C8 (execute): an extract_schema_invalid TransformError degrades to raw with reason schema_validation_failed", async () => {
  const text = "Some real page content that satisfies the extract path so the transform seam is reached.";
  const html = `<main>${text}</main>`;
  const htmlBytes = new TextEncoder().encode(html);
  const fetcher: FetcherPort = {
    async fetchGuarded(): Promise<FetcherResult> {
      return {
        status: 200,
        finalUrl: "https://x.test/",
        redirects: [],
        bodyStream: new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(htmlBytes); controller.close(); },
        }),
        contentType: "text/html; charset=utf-8",
        bytes: htmlBytes.byteLength,
      };
    },
  };
  const transformer: TransformPort = {
    async transform(): Promise<never> {
      throw new TransformError("extract_schema_invalid", "simulated unsupported-keyword failure");
    },
  };
  const extractHtml = (_input: HtmlExtractionInput): HtmlExtraction => ({
    text,
    structured: {},
    shellGate: {
      jsRequired: false,
      reason: "content-present",
      textLength: text.length,
      wordCount: text.split(/\s+/).length,
      scriptCount: 0,
      appRootFound: false,
      structuredDataFound: false,
    },
    errors: [],
  });

  const useCase = createCaptatumUseCase({
    fetcher,
    extractHtml,
    transformer,
    adapters: new PlatformAdapterRegistry([]),
    clock: { nowMs: () => 0 },
  });

  const result = await useCase.execute({
    url: "https://x.test/",
    output: "extract",
    schema: { type: "object", properties: { a: { type: "string" } } },
  });

  assert.equal(result.output, "raw", "the extract degrade returns raw");
  assert.equal(result.transform?.provider, "none");
  assert.equal(
    result.transform?.reason,
    "schema_validation_failed",
    "the captatum.ts catch maps extract_schema_invalid → schema_validation_failed (not the catch-all transform_failed)",
  );
});

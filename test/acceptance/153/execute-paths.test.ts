// FROZEN acceptance suite for #153 — execute-path WRITERS (the captatum.ts catch must EMIT the
// renamed reasons). The C8-execute test in receipt.test.ts covers the extract_schema_invalid →
// schema_validation_failed branch; this file covers the catch's OTHER branch — a GENERIC transform
// failure must degrade with reason "transform_failed", NOT the legacy "failed".
// Authored INDEPENDENTLY of the implementation. This WILL FAIL against the current catch (which
// hardcodes reason "failed"); the implementer CANNOT edit this file — activate phase 153.
// Spec: docs/specs/153-extract-schema-input-validation.md — criterion C6 (transform_failed reason).

import assert from "node:assert/strict";
import { test } from "node:test";
import { createCaptatumUseCase } from "../../../src/application/use-cases/captatum.ts";
import type { TransformPort } from "../../../src/application/ports/transformer.ts";
import type { FetcherPort, FetcherResult } from "../../../src/application/ports/fetcher.ts";
import { PlatformAdapterRegistry } from "../../../src/application/ports/platform-adapter.ts";
import type { HtmlExtraction, HtmlExtractionInput } from "../../../src/application/use-cases/tier1-extract.ts";

test("C6 (execute): a generic transform failure degrades to raw with reason transform_failed", async () => {
  const text = "Some real page content so the transform seam is reached against a real body.";
  const htmlBytes = new TextEncoder().encode(`<main>${text}</main>`);
  const fetcher: FetcherPort = {
    async fetchGuarded(): Promise<FetcherResult> {
      return {
        status: 200, finalUrl: "https://x.test/", redirects: [],
        bodyStream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(htmlBytes); c.close(); } }),
        contentType: "text/html; charset=utf-8", bytes: htmlBytes.byteLength,
      };
    },
  };
  // A PLAIN generic failure — NOT a TransformError, NOT extract_schema_invalid. This targets the
  // captatum.ts catch's "else" branch, proving it EMITS the renamed "transform_failed" reason.
  const transformer: TransformPort = {
    async transform(): Promise<never> { throw new Error("generic provider boom"); },
  };
  const extractHtml = (_input: HtmlExtractionInput): HtmlExtraction => ({
    text, structured: {},
    shellGate: { jsRequired: false, reason: "content-present", textLength: text.length,
      wordCount: text.split(/\s+/).length, scriptCount: 0, appRootFound: false, structuredDataFound: false },
    errors: [],
  });
  const useCase = createCaptatumUseCase({
    fetcher, extractHtml, transformer, adapters: new PlatformAdapterRegistry([]), clock: { nowMs: () => 0 },
  });

  const result = await useCase.execute({ url: "https://x.test/", output: "summary" });

  assert.equal(result.output, "raw", "a failed transform degrades to raw");
  assert.equal(result.transform?.provider, "none");
  assert.equal(
    result.transform?.reason,
    "transform_failed",
    "the captatum.ts catch emits the renamed reason for a generic failure — NOT the legacy 'failed'",
  );
});

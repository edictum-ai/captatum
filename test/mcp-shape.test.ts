import assert from "node:assert/strict";
import { test } from "node:test";
import type { Result } from "../src/domain/result.ts";
import { resultToMcpText } from "../src/interfaces/mcp/format.ts";
import { buildStructuredContent } from "../src/interfaces/mcp/shape.ts";

function base(overrides: Partial<Result> = {}): Result {
  return {
    url: "https://example.test/article",
    bytes: 1000,
    code: 200,
    codeText: "OK",
    durationMs: 50,
    result: "Clean extracted content the agent can read.",
    schemaVersion: 1,
    finalUrl: "https://example.test/article",
    redirects: [],
    tier: 1,
    output: "raw",
    platform: { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier1" },
    jsRequired: false,
    resolvedVia: "tier1-jsonld",
    attempts: [{ step: 1, tier: 1, outcome: "ok", status: 200, durationMs: 50, bytes: 1000, reason: "content-present" }],
    contentType: "text/html; charset=utf-8",
    title: "Example Article",
    timings: { totalMs: 50, fetchMs: 50 },
    errors: [],
    ...overrides,
  };
}

test("lean payload carries the tiered fields and load-bearing primitives", () => {
  const shape = buildStructuredContent(base({ structured: { images: ["https://cdn.test/a.jpg"] } }), false);
  assert.equal(shape.ok, true);
  assert.equal(shape.status, "pass");
  assert.equal(shape.contentType, "unknown");
  assert.deepEqual(shape.access, { mainContentAccessible: true, gated: false, gateReason: "none" });
  assert.deepEqual(shape.provenance, { tier: 1, resolvedVia: "tier1-jsonld", code: 200, bytes: 1000 });
  assert.deepEqual(shape.images, ["https://cdn.test/a.jpg"]);
  assert.deepEqual(shape.warnings, []);
  assert.deepEqual(shape.errors, []);
  // load-bearing primitives kept at top level for existing connectors
  assert.equal(shape.result, "Clean extracted content the agent can read.");
  assert.equal(shape.tier, 1);
  assert.equal(shape.title, "Example Article");
});

test("4xx/5xx response: the receipt is fail + http_error, never pass + accessible [GUARD, was GAP]", () => {
  // A non-empty error body (text/plain 'Forbidden', JSON error, rich HTML error) used to be
  // presented as a successful, public, non-gated fetch (status:pass, access:none, ok:true).
  // Now classifyAccess gates it http_error and classifyStatus fails it. The body is still in
  // result.result so the agent can read the server's message.
  const r = buildStructuredContent(base({
    code: 404,
    codeText: "Not Found",
    result: "404: Not Found",
    jsRequired: false,
    resolvedVia: "tier1-error",
    errors: [{ code: "http_error", message: "HTTP 404 Not Found" }],
  }), false);
  assert.equal(r.status, "fail", "a 4xx is an honest failure, not pass/partial");
  assert.equal(r.ok, false);
  assert.deepEqual(r.access, { mainContentAccessible: false, gated: true, gateReason: "http_error" });
  assert.equal(r.code, 404);
  assert.equal(r.result, "404: Not Found", "the error body is still returned for the agent to read");
});

test("heavy fields are absent by default and unlocked with debug: true", () => {
  const lean = buildStructuredContent(base(), false);
  assert.equal("attempts" in lean, false);
  assert.equal("timings" in lean, false);
  assert.equal("structured" in lean, false);
  assert.equal("redirects" in lean, false);
  assert.equal("contentSha256" in lean, false);
  assert.equal("provenanceHash" in lean, false);

  const debug = buildStructuredContent(
    base({ structured: { jsonLd: { "@type": "Article", articleBody: "x".repeat(500) } } }),
    true,
  );
  assert.ok(Array.isArray(debug.attempts));
  assert.ok(typeof debug.timings === "object");
  assert.ok(typeof debug.structured === "object");
  assert.equal((debug.structured as { jsonLd: { articleBody: string } }).jsonLd.articleBody.length, 500);
});

test("transform stays lean by default; verbose fields only in debug", () => {
  const transform = {
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    free: true,
    inTokens: 1200,
    outTokens: 80,
    latencyMs: 900,
    costUsd: 0.0001,
    reason: "selected",
  };
  const lean = buildStructuredContent(base({ output: "summary", transform }), false);
  assert.deepEqual(lean.transform, {
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    free: true,
    inTokens: 1200,
    outTokens: 80,
    reason: "selected", // small + load-bearing fallback signal; stays in the lean payload
  });

  const debug = buildStructuredContent(base({ output: "summary", transform }), true);
  assert.equal((debug.transform as { latencyMs: number }).latencyMs, 900);
  assert.equal((debug.transform as { costUsd: number }).costUsd, 0.0001);
});

test("founder regression guard: JSON-LD description/articleBody never leak into the lean payload", () => {
  const lean = buildStructuredContent(
    base({ structured: { jsonLd: { "@type": "Article", description: "SSECRET_DESC", articleBody: "SSECRET_BODY" } } }),
    false,
  );
  const serialized = JSON.stringify(lean);
  assert.ok(!serialized.includes("SSECRET_DESC"), "description leaked into lean payload");
  assert.ok(!serialized.includes("SSECRET_BODY"), "articleBody leaked into lean payload");
  // ...but they ARE available in debug.
  const debug = buildStructuredContent(
    base({ structured: { jsonLd: { "@type": "Article", description: "SSECRET_DESC", articleBody: "SSECRET_BODY" } } }),
    true,
  );
  assert.ok(JSON.stringify(debug).includes("SSECRET_BODY"));
});

test("lean payload preserves the legacy top-level field set connectors already read", () => {
  const lean = buildStructuredContent(base(), false);
  assert.deepEqual(
    Object.keys(lean).sort(),
    [
      "access", "bytes", "code", "codeText", "contentType", "errors", "finalUrl",
      "images", "jsRequired", "ok", "output", "platform", "provenance", "resolvedVia",
      "result", "schemaVersion", "status", "tier", "title", "url", "warnings",
    ],
  );
});

test("tier 2 (platform adapter) success is status pass with content accessible", () => {
  const shape = buildStructuredContent(
    base({ tier: 2, resolvedVia: "tier2-adapter", platform: { adapterId: "ashby", label: "Ashby", detectedFrom: "tier2" } }),
    false,
  );
  assert.equal(shape.status, "pass");
  assert.equal(shape.access.mainContentAccessible, true);
  assert.equal(shape.access.gateReason, "none");
});

test("tier none / render-unavailable with empty content is status fail", () => {
  const none = buildStructuredContent(base({ tier: "none", result: "" }), false);
  assert.equal(none.status, "fail");
  assert.equal(none.access.mainContentAccessible, false);

  const unavailable = buildStructuredContent(
    base({ tier: "render-unavailable", resolvedVia: "render-unavailable", jsRequired: true, result: "" }),
    false,
  );
  assert.equal(unavailable.status, "fail");
  assert.equal(unavailable.access.gateReason, "js-required");
});

test("contentType handles @graph, @type arrays, full IRIs, and multi-type precedence", () => {
  // @graph + full IRI
  assert.equal(
    buildStructuredContent(base({ structured: { jsonLd: { "@graph": [{ "@type": "https://schema.org/JobPosting" }] } } }), false).contentType,
    "job",
  );
  // @type array: [Article, JobPosting] -> job wins by precedence (not array order)
  assert.equal(
    buildStructuredContent(base({ structured: { jsonLd: { "@type": ["Article", "JobPosting"] } } }), false).contentType,
    "job",
  );
  // WebPage is NOT an article
  assert.equal(
    buildStructuredContent(base({ structured: { jsonLd: { "@type": "WebPage" } } }), false).contentType,
    "unknown",
  );
  // explicit JobPosting on a pinterest.* host wins over the pin heuristic
  assert.equal(
    buildStructuredContent(
      base({ finalUrl: "https://www.pinterest.com/careers/1", structured: { jsonLd: { "@type": "JobPosting" } } }),
      false,
    ).contentType,
    "job",
  );
  // www.pin.it short link (no structured data) -> pin
  assert.equal(buildStructuredContent(base({ finalUrl: "https://www.pin.it/abc" }), false).contentType, "pin");
});

test("render-failed-but-tier1-ok is a warning, not a fatal error", () => {
  const shape = buildStructuredContent(
    base({ tier: 1, result: "Tier-1 body present", errors: [{ code: "render_error", message: "Playwright crashed (advisory)" }] }),
    false,
  );
  assert.deepEqual(shape.errors, []);
  assert.deepEqual(shape.warnings, [{ code: "render_error", message: "Playwright crashed (advisory)" }]);
  assert.equal(shape.status, "partial");
});

test("successful extract carries the JSON result and still classifies contentType", () => {
  const shape = buildStructuredContent(
    base({ output: "extract", result: JSON.stringify({ title: "Hello" }), structured: { jsonLd: { "@type": "Product" } } }),
    false,
  );
  assert.equal(shape.result, JSON.stringify({ title: "Hello" }));
  assert.equal(shape.contentType, "product");
  assert.equal(shape.status, "pass");
});

test("images is an empty array (never absent) when none are found", () => {
  const lean = buildStructuredContent(base(), false);
  assert.ok("images" in lean);
  assert.deepEqual(lean.images, []);
});

test("structuredContent.result is snippeted when large; full text stays in the text channel", () => {
  const big = "x".repeat(5000);
  const result = base({ result: big });
  const lean = buildStructuredContent(result, false);
  const shaped = lean.result as string;
  assert.ok(shaped.length < big.length, "large result must be snippeted in the lean payload");
  assert.match(shaped, /snippeted in this lean payload/);
  assert.match(shaped, /content\[0\]\.text/, "the note points to the canonical MCP text channel");
  // The full text is still delivered via the MCP text channel (content[0].text).
  assert.ok(resultToMcpText(result).includes(big));
});

test("summary text carries a deterministic envelope header for cross-client visibility", () => {
  const result = base({
    output: "summary",
    finalUrl: "https://example.test/article",
    title: "Example Article",
    transform: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
    structured: { images: ["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"] },
  });
  const text = resultToMcpText(result);
  assert.match(text, /^<!-- captatum /);
  assert.match(text, /contentType: unknown/);
  assert.match(text, /title: Example Article/);
  assert.match(text, /finalUrl: https:\/\/example\.test\/article/);
  assert.match(text, /access: public/);
  assert.match(text, /images: 2 \(e\.g\. https:\/\/cdn\.test\/a\.jpg\)/);
  assert.match(text, /transformModel: deepseek\/deepseek-v4-flash/);
  // header sits between the provenance comment and the summary body
  assert.ok(text.indexOf("transformModel:") < text.indexOf("Clean extracted content"));
});

test("raw output has no envelope header (text unchanged for the contract fixtures)", () => {
  const text = resultToMcpText(base({ output: "raw" }));
  assert.doesNotMatch(text, /contentType:|transformModel:|^access:/m);
  // single newline between the provenance comment and the body (fixture contract)
  assert.match(text, /^<!-- captatum[^\n]*-->\n/);
});

test("raw JSON bodies (application/json AND +json suffixes) stay parseable — no provenance prefix (#94 review)", () => {
  // A +json suffix (vnd.api+json, ld+json, …) is a single parseable JSON document and must skip
  // the prepended provenance comment, or content[0].text stops being valid JSON for raw consumers.
  for (const ct of ["application/json", "application/json; charset=utf-8", "application/vnd.api+json", "application/ld+json"]) {
    const body = '{"ok":true}';
    const text = resultToMcpText(base({ output: "raw", contentType: ct, result: body }));
    assert.equal(text, body, `raw ${ct} body must be returned without the provenance prefix`);
  }
  // Non-JSON raw bodies still get the provenance comment.
  const html = resultToMcpText(base({ output: "raw", contentType: "text/html; charset=utf-8", result: "<p>hi</p>" }));
  assert.match(html, /^<!-- captatum/);
});

test("fatal errors (tier error) surface in errors; advisories become warnings", () => {
  const rejected = base({
    tier: "error",
    code: 0,
    codeText: "FETCH_REJECTED",
    resolvedVia: "guarded-fetch",
    result: "Host resolves to a private or reserved address",
    jsRequired: false,
    attempts: [{ step: 1, tier: 1, outcome: "block", durationMs: 0, reason: "private_address" }],
    errors: [{ code: "private_address", message: "Host resolves to a private or reserved address" }],
  });
  const shape = buildStructuredContent(rejected, false);
  assert.equal(shape.ok, false);
  assert.equal(shape.status, "fail");
  assert.deepEqual(shape.errors, [{ code: "private_address", message: "Host resolves to a private or reserved address" }]);
  assert.deepEqual(shape.warnings, []);
  assert.equal(shape.access.mainContentAccessible, false);
});

test("non-fatal advisory (extract_schema_invalid) is a warning and status partial", () => {
  const shape = buildStructuredContent(
    base({ output: "extract", errors: [{ code: "extract_schema_invalid", message: "missing required field" }] }),
    false,
  );
  assert.equal(shape.status, "partial");
  assert.deepEqual(shape.errors, []);
  assert.deepEqual(shape.warnings, [{ code: "extract_schema_invalid", message: "missing required field" }]);
});

test("summary that fell back to raw (provider none) is status partial", () => {
  const shape = buildStructuredContent(
    base({ output: "raw", transform: { provider: "none", reason: "unconfigured" } }),
    false,
  );
  assert.equal(shape.status, "partial");
});

test("contentType classification: job / product / article / pin / spa", () => {
  assert.equal(buildStructuredContent(base({ structured: { jsonLd: { "@type": "JobPosting" } } }), false).contentType, "job");
  assert.equal(buildStructuredContent(base({ structured: { jsonLd: { "@type": "Product" } } }), false).contentType, "product");
  assert.equal(buildStructuredContent(base({ structured: { jsonLd: { "@type": "NewsArticle" } } }), false).contentType, "article");
  assert.equal(buildStructuredContent(base({ structured: { og: { "og:type": "article" } } }), false).contentType, "article");
  assert.equal(buildStructuredContent(base({ finalUrl: "https://www.pinterest.com/pin/123/" }), false).contentType, "pin");
  assert.equal(buildStructuredContent(base({ jsRequired: true, tier: "render-blocked", resolvedVia: "render-blocked", result: "" }), false).contentType, "spa");
});

test("access gating: paywall / byte_cap / login", () => {
  const paywall = buildStructuredContent(base({ structured: { jsonLd: { "@type": "Article", isAccessibleForFree: false } } }), false);
  assert.deepEqual(paywall.access, { mainContentAccessible: true, gated: true, gateReason: "paywall" });

  const truncated = buildStructuredContent(base({ errors: [{ code: "max_bytes", message: "Content truncated at the byte cap" }] }), false);
  assert.deepEqual(truncated.access, { mainContentAccessible: true, gated: true, gateReason: "byte_cap" });

  // #149: a mid-read transport truncation (body_read_error) is gated LIKE a cap truncation —
  // partial, transport-unreliable bytes (possibly garbled from a broken gzip stream) must NOT
  // present as complete/public. Teeth-check: without the classifyAccess fix this falls through
  // to gateReason "none" (public) — the opposite of the lower-risk max_bytes case.
  const bodyRead = buildStructuredContent(base({ errors: [{ code: "body_read_error", message: "Response body truncated mid-read (transport error)" }] }), false);
  assert.deepEqual(bodyRead.access, { mainContentAccessible: true, gated: true, gateReason: "byte_cap" });

  // #149 codex P2: a ZERO-BYTE total body_read_error reject (tier:error, bytes:0 — the stream
  // broke before any content, after the retry also failed) carries the SAME body_read_error code,
  // but it is a FAILED FETCH, not partial content. It must NOT be gated byte_cap (would misreport a
  // dead fetch as an inaccessible/truncated page). Teeth-check: without the tier!=="error" gate this
  // returns gateReason "byte_cap".
  const zeroByteFail = buildStructuredContent(base({ tier: "error", code: 0, bytes: 0, result: "", resolvedVia: "guarded-fetch", errors: [{ code: "body_read_error", message: "Response body could not be read safely" }] }), false);
  assert.notEqual(zeroByteFail.access.gateReason, "byte_cap", "a zero-byte total failure is not a truncation");
  assert.equal(zeroByteFail.status, "fail");

  const jsRequired = buildStructuredContent(base({ jsRequired: true, tier: "render-blocked", resolvedVia: "render-blocked", result: "" }), false);
  assert.deepEqual(jsRequired.access, { mainContentAccessible: false, gated: true, gateReason: "js-required" });
  assert.equal(jsRequired.status, "fail");
});

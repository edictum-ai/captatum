import assert from "node:assert/strict";
import { test } from "node:test";
import type { Result } from "../src/domain/result.ts";
import { classifyContentQuality, stampContentQuality } from "../src/application/content-quality.ts";

function result(over: Partial<Result> = {}): Result {
  return {
    url: "https://example.test/", bytes: 1000, code: 200, codeText: "OK", durationMs: 50,
    result: "Real content the agent can read.", schemaVersion: 1, finalUrl: "https://example.test/", redirects: [],
    tier: 3, output: "raw",
    platform: { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier3" },
    jsRequired: true, resolvedVia: "tier3-playwright", attempts: [],
    contentType: "text/html", timings: { totalMs: 50, fetchMs: 40 }, errors: [],
    ...over,
  } as Result;
}

// ---------- #145: app_error (client-app error-boundary screen) ----------

test("classifyContentQuality: a client-app error-boundary screen → app_error (#145)", () => {
  // The Cursor repro: a short rendered result that IS the crash screen ("Something went wrong…").
  assert.equal(classifyContentQuality(result({ result: "Something went wrong A critical error occurred. Please try again." })), "app_error");
  assert.equal(classifyContentQuality(result({ result: "Application error: a client-side exception" })), "app_error");
});

test("classifyContentQuality: app_error requires a SHORT result — a real article about errors is longer (FP guard)", () => {
  const longResult = "Something went wrong in production today. " + "x".repeat(400); // > 300 chars
  assert.equal(classifyContentQuality(result({ result: longResult })), undefined);
});

test("classifyContentQuality: a normal short result is NOT app_error (no crash signature)", () => {
  assert.equal(classifyContentQuality(result({ result: "A short but legitimate page about things." })), undefined);
});

// ---------- #150: low_value (HTTP success, near-empty useful content) ----------

test("classifyContentQuality: thin large page with a generic title + no JSON-LD → low_value (#150)", () => {
  // The JetBrains repro: a rendered SPA whose visible text is just "Careers".
  assert.equal(classifyContentQuality(result({ result: "Careers", bytes: 250_000, title: "Careers" })), "low_value");
});

test("classifyContentQuality: a JobPosting page is NOT low_value (content-bearing JSON-LD)", () => {
  assert.equal(classifyContentQuality(result({
    result: "Careers", bytes: 250_000, title: "Careers",
    structured: { jsonLd: { "@type": "JobPosting", title: "Senior Engineer" } },
  })), undefined);
});

test("classifyContentQuality: low_value requires large bytes — a small thin page is not flagged (FP guard)", () => {
  assert.equal(classifyContentQuality(result({ result: "Careers", bytes: 5_000, title: "Careers" })), undefined);
});

test("classifyContentQuality: low_value requires a generic title — a real subject title is not flagged (FP guard)", () => {
  assert.equal(classifyContentQuality(result({ result: "Careers at Acme", bytes: 250_000, title: "Engineering at Acme" })), undefined);
});

// ---------- stamping ----------

test("stampContentQuality: app_error DEMOTES to tier:error + render_app_error (#145)", () => {
  const r = result({ result: "Something went wrong. A critical error occurred.", tier: 3 });
  stampContentQuality(r);
  assert.equal(r.contentQuality, "app_error");
  assert.equal(r.tier, "error", "demoted — a crash screen is not usable content");
  assert.ok(r.errors.some((e) => e.code === "render_app_error"));
});

test("stampContentQuality: low_value adds a NON-fatal warning (tier unchanged) (#150)", () => {
  const r = result({ result: "Careers", bytes: 250_000, title: "Careers", tier: 3 });
  stampContentQuality(r);
  assert.equal(r.contentQuality, "low_value");
  assert.equal(r.tier, 3, "NOT demoted — low_value is a warning, not a failure");
  assert.ok(r.errors.some((e) => e.code === "low_value_extraction"));
});

test("stampContentQuality: a normal result is untouched (no-op)", () => {
  const r = result({ result: "A real article about captatum and trustworthy web fetching." });
  stampContentQuality(r);
  assert.equal(r.contentQuality, undefined);
  assert.equal(r.errors.length, 0);
});

test("stampContentQuality: a failed fetch (tier:error) is not content-quality-classified", () => {
  // A FETCH_REJECTED carrying "something went wrong"-ish text must not be re-classified.
  const r = result({ result: "Something went wrong", tier: "error" });
  stampContentQuality(r);
  assert.equal(r.contentQuality, undefined);
});

// ---------- tightened precision (codex/self-review FP findings) ----------

test("classifyContentQuality: a Tier-1 help doc QUOTING the phrase is NOT app_error (tier gate)", () => {
  // Error-boundary screens are a RENDERED (tier 3) phenomenon — a static help/status page is not.
  assert.equal(classifyContentQuality(result({ tier: 1, result: "If you see 'Something went wrong', click retry to reload the app." })), undefined);
});

test("classifyContentQuality: a JSON API error body is NOT app_error (tier gate excludes JSON)", () => {
  assert.equal(classifyContentQuality(result({ tier: 1, contentType: "application/json", result: '{"error":"something went wrong","request_id":"abc"}' })), undefined);
});

test("classifyContentQuality: a tier-3 page that includes but does NOT LEAD WITH the signature is NOT app_error (startsWith)", () => {
  // A crash screen's text IS the error message (leads with it); a page that merely mentions it doesn't.
  assert.equal(classifyContentQuality(result({ tier: 3, result: "Welcome to Acme. If something went wrong during signup, contact support." })), undefined);
});

test("classifyContentQuality: an Event/Recipe page is NOT low_value (content-bearing JSON-LD, not just job/product/article)", () => {
  // #150 codex: the extractor treats Event/Recipe/Course/Review/etc. as content-bearing too.
  assert.equal(classifyContentQuality(result({
    result: "Events", bytes: 250_000, title: "Home",
    structured: { jsonLd: { "@type": "Event", name: "Annual Conference", description: "A real event with details." } },
  })), undefined);
});

test("classifyContentQuality: an anti-bot challenge is NOT content-quality-classified", () => {
  // A challenge is already gated (challengeProvider set), not "low-quality content".
  assert.equal(classifyContentQuality(result({ challengeProvider: "cloudflare", result: "Just a moment...", title: "Just a moment..." })), undefined);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { transformContent } from "../src/application/use-cases/transform-content.ts";
import type { Result } from "../src/domain/result.ts";

function bare(over: Partial<Result>): Result {
  return {
    url: "https://x.test", bytes: 0, code: 200, codeText: "OK", durationMs: 0, result: "",
    schemaVersion: 1, finalUrl: "https://x.test", redirects: [], tier: 1, output: "summary",
    platform: { adapterId: "generic", label: "Generic", detectedFrom: "tier1" }, jsRequired: false,
    resolvedVia: "tier1", attempts: [], contentType: "text/html", timings: { totalMs: 0, fetchMs: 0 }, errors: [],
    ...over,
  };
}

test("transformContent prepends title + OG description when body is gated/thin (Pinterest regression)", () => {
  const c = transformContent(bare({
    title: "Decoração Festa Infantil fundo do mar",
    result: "", // login-gated body, no real content
    structured: { og: { "og:title": "Decoração Festa Infantil fundo do mar", "og:description": "Underwater party ideas" } },
  }));
  assert.ok(c.startsWith("Title: Decoração Festa Infantil fundo do mar"), `expected title preamble, got: ${c.slice(0, 80)}`);
  assert.ok(c.includes("Description: Underwater party ideas"));
});

test("transformContent appends JSON-LD as verified fields when present", () => {
  const c = transformContent(bare({
    title: "Job", result: "body text",
    structured: { jsonLd: { "@type": "JobPosting", title: "Job" } },
  }));
  assert.ok(c.includes("Title: Job"));
  assert.ok(c.includes("body text"));
  assert.ok(c.includes("Verified structured data (JSON-LD)"));
});

test("transformContent strips articleBody/description from JSON-LD (keeps metadata)", () => {
  const c = transformContent(bare({
    result: "visible body text",
    structured: {
      jsonLd: {
        "@type": "NewsArticle",
        headline: "H",
        articleBody: "HUGE DUPLICATED BODY TEXT",
        description: "long verbose description",
        author: { "@type": "Person", name: "Ada" },
      },
    },
  }));
  assert.ok(c.includes("visible body text"), "body still present");
  assert.ok(c.includes("NewsArticle"), "metadata kept");
  assert.ok(c.includes("Ada"), "nested metadata kept");
  assert.ok(!c.includes("HUGE DUPLICATED BODY TEXT"), "articleBody must be stripped");
  assert.ok(!c.includes("long verbose description"), "description must be stripped");
});

test("transformContent has no preamble when no metadata", () => {
  const c = transformContent(bare({ result: "just body" }));
  assert.equal(c, "just body");
});

// Non-frozen impl-detail tests for #152 (the frozen contract is in test/acceptance/152/).
// Covers: shortSchemaType normalization forms, the @type-array + harvest caps (DoS bound), and
// the structured descent (HowToSection / recipeInstructions HowToStep[]).
import assert from "node:assert/strict";
import { test } from "node:test";
import { shortSchemaType, shortTypes, CONTENT_TYPES, MAX_TYPE_ARRAY } from "../src/domain/content-types.ts";
import { harvestContentText } from "../src/domain/content-harvest.ts";
import { classifyContentType } from "../src/application/classify.ts";
import type { Result } from "../src/domain/result.ts";

const base = (over: Partial<Result> = {}): Result => ({
  url: "https://x.test/", bytes: 100, code: 200, codeText: "OK", durationMs: 1, result: "x",
  schemaVersion: 1, finalUrl: "https://x.test/", redirects: [], tier: 1, output: "raw",
  platform: { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier1" },
  jsRequired: false, resolvedVia: "tier1-text", attempts: [], contentType: "text/html",
  timings: { totalMs: 1, fetchMs: 1 }, errors: [], ...over,
});

test("#152 shortSchemaType: IRI, trailing-slash, whitespace, and last-segment forms normalize", () => {
  assert.equal(shortSchemaType("JobPosting"), "jobposting");
  assert.equal(shortSchemaType("https://schema.org/Article"), "article");
  assert.equal(shortSchemaType("https://schema.org/WebPage/"), "webpage", "trailing slash stripped before last-segment");
  assert.equal(shortSchemaType("  JobPosting  "), "jobposting", "whitespace trimmed");
  assert.equal(shortSchemaType("https://schema.org/FAQPage"), "faqpage");
});

test("#152 shortSchemaType: CURIE prefix forms are intentionally NOT normalized (safe extra render)", () => {
  assert.equal(shortSchemaType("schema:JobPosting"), "schema:jobposting", "CURIE not split → misses CONTENT_TYPES → render");
  assert.equal(CONTENT_TYPES.has("schema:jobposting"), false);
});

test("#152: the @type array is count-capped (a 100k-@type array is O(MAX_TYPE_ARRAY), not O(n))", () => {
  const hugeType = Array.from({ length: 100_000 }, (_, i) => `Type${i}`);
  hugeType.push("JobPosting");
  const node = { "@type": hugeType, title: "Eng" };
  // shortTypes caps at MAX_TYPE_ARRAY; the JobPosting (past the cap) is missed — a safe non-satisfaction.
  const types = shortTypes(node);
  assert.ok(types.length <= MAX_TYPE_ARRAY, `@type array capped ≤ ${MAX_TYPE_ARRAY}; got ${types.length}`);
  assert.ok(!types.includes("jobposting"), "a data type past the cap is not seen (bounded work, safe extra render)");
});

test("#152: harvest caps bound a hostile step[] / mainEntity[] (slice-then-normalize, bounded output)", () => {
  // A 100k-step HowTo + a 100k-question FAQPage must yield bounded text, not O(100k) output.
  const howto = { "@type": "HowTo", step: Array.from({ length: 100_000 }, (_, i) => ({ "@type": "HowToStep", text: `step ${i}` })) };
  const faq = { "@type": "FAQPage", mainEntity: Array.from({ length: 100_000 }, (_, i) => ({ "@type": "Question", name: `Q${i}?`, acceptedAnswer: { "@type": "Answer", text: `A${i}` } })) };
  const h = harvestContentText(howto)!;
  const f = harvestContentText(faq)!;
  assert.ok(h.length < 10_000, `HowTo harvest bounded (got ${h.length}); steps slice-then-normalized`);
  assert.ok(f.length < 10_000, `FAQ harvest bounded (got ${f.length}); mainEntity slice-then-normalized`);
});

test("#152: HowToSection nesting is descended (its itemListElement steps are harvested, not just the section name)", () => {
  const howto = { "@type": "HowTo", step: [
    { "@type": "HowToStep", text: "Cut the wood." },
    { "@type": "HowToSection", name: "Assembly", itemListElement: [{ "@type": "HowToStep", text: "Glue the joints." }] },
  ] };
  const h = harvestContentText(howto)!;
  assert.match(h, /Cut the wood/);
  assert.match(h, /Glue the joints/, "HowToSection's nested steps are harvested");
});

test("#152: recipeInstructions HowToStep[] is descended per-element (not string-coerced to [object Object])", () => {
  const recipe = { "@type": "Recipe", recipeInstructions: [
    { "@type": "HowToStep", text: "Preheat oven to 350." },
    { "@type": "HowToStep", text: "Bake 25 min." },
  ] };
  const r = harvestContentText(recipe)!;
  assert.match(r, /Preheat oven/);
  assert.match(r, /Bake 25 min/);
  assert.ok(!r.includes("[object Object]"), "HowToStep[] not string-coerced");
});

// --- codex P2 regression guards ---

test("#152 codex: shortSchemaType trims BEFORE the trailing-slash strip (whitespace + IRI + slash)", () => {
  assert.equal(shortSchemaType(" https://schema.org/JobPosting/ "), "jobposting");
  assert.equal(shortSchemaType("\thttps://schema.org/Article/\t"), "article");
});

test("#152 codex: harvestSteps handles Text[] (string elements) and an ItemList wrapper", () => {
  // Text[]: a recipe whose instructions are an array of plain strings.
  const textArr = harvestContentText({ "@type": "Recipe", recipeInstructions: ["Preheat oven.", "Bake 25 min."] })!;
  assert.match(textArr, /Preheat oven/);
  assert.match(textArr, /Bake 25 min/);
  // ItemList wrapper: howto steps wrapped in an ItemList.
  const itemList = harvestContentText({ "@type": "HowTo", step: { "@type": "ItemList", itemListElement: [{ "@type": "HowToStep", text: "Cut the wood." }] } })!;
  assert.match(itemList, /Cut the wood/);
});

test("#152 codex: a Pinterest pin page (SocialMediaPosting JSON-LD) classifies 'pin', not 'article'", () => {
  const pin = base({
    finalUrl: "https://www.pinterest.com/pin/1618549864698060/",
    structured: { jsonLd: { "@type": "SocialMediaPosting", articleBody: "a pin caption" } },
  });
  assert.equal(classifyContentType(pin), "pin", "isPinHost wins over the SocialMediaPosting JSON-LD type");
});


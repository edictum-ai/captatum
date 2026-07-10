// FROZEN acceptance suite for #152 — the shell-gate JSON-LD data-`@type` allowlist contract.
// Locks: (a) which schema.org @types satisfy the shell-gate's JSON-LD path (CONTENT_TYPES) AND
// yield a non-empty Tier-1 harvest; (b) the bug-class negatives (scaffolding / @type-less /
// metadata / VideoObject / bare-type / name-only-media / off-pin SocialMediaPosting → NOT
// satisfied); (c) the #109 reversal (WebPage+description no longer satisfies). Contract only —
// impl details (exact CONTENT_TYPES count, shortSchemaType normalization, cap values, DoS bound)
// live in non-frozen test/*.test.ts. Editing this file turns CI red (process-guard freeze-hash).

import assert from "node:assert/strict";
import { test } from "node:test";
import { hasContentBearingJsonLd } from "../../../src/domain/content-bearing.ts";
import { buildPayload } from "../../../src/application/use-cases/tier1-payload.ts";
import type { StructuredData } from "../../../src/domain/platform.ts";

const SD = (jsonLd: unknown): StructuredData => ({ jsonLd }) as StructuredData;
const PIN = "https://www.pinterest.com/pin/1618549864698060/";
const NONPIN = "https://news.test/article/123";

// C1 — POSITIVE: each representative CONTENT_TYPES @type WITH a content field satisfies the gate
// AND yields a non-empty Tier-1 harvest (gate set == harvester set invariant). (#152)
test("C1: each CONTENT_TYPES data type + content field satisfies the gate and yields a non-empty harvest", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["jobposting", { "@type": "JobPosting", title: "Platform Engineer" }],
    ["article", { "@type": "Article", headline: "Breaking Story" }],
    ["product", { "@type": "Product", description: "A widget an agent can read about." }],
    ["review", { "@type": "Review", reviewBody: "Great product — five stars." }],
    ["recipe", { "@type": "Recipe", recipeInstructions: [{ "@type": "HowToStep", text: "Preheat oven to 350." }] }],
    ["howto (steps)", { "@type": "HowTo", step: [{ "@type": "HowToStep", text: "Cut the wood." }, { "@type": "HowToSection", name: "Assembly", itemListElement: [{ "@type": "HowToStep", text: "Glue the joints." }] }] }],
    ["faqpage", { "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "What is this?", acceptedAnswer: { "@type": "Answer", text: "An answer." } }] }],
    ["question", { "@type": "Question", name: "Why?", acceptedAnswer: { "@type": "Answer", text: "Because." } }],
    ["dataset", { "@type": "Dataset", description: "A harvestable dataset description." }],
    ["softwareapplication", { "@type": "SoftwareApplication", description: "An app description." }],
    ["movie", { "@type": "Movie", description: "A film description." }],
    ["restaurant", { "@type": "Restaurant", description: "A restaurant description." }],
  ];
  for (const [label, node] of cases) {
    assert.equal(hasContentBearingJsonLd(node), true, `gate satisfied: ${label}`);
    const lead = buildPayload("raw", SD(node), "", "https://x.test/p");
    assert.ok(lead && lead.trim().length > 0, `non-empty harvest: ${label} (got ${JSON.stringify(lead)})`);
  }
});

// C2 — NEGATIVE: the bug class — metadata / scaffolding / @type-less / bare / name-only / off-pin
// do NOT satisfy the gate (so a JS-rendered listing page whose static HTML carries only metadata
// JSON-LD escalates to render instead of stopping at an empty Tier-1). (#152; StartupJobs/NoFluffJobs)
test("C2: metadata / scaffolding / @type-less / bare / name-only / off-pin do NOT satisfy the gate", () => {
  const notSatisfying: unknown[] = [
    { "@type": "WebPage", description: "A real page summary." },                         // scaffolding+description (#109 reversal)
    { "@type": "WebPage", name: "X" },                                                   // scaffolding, no content field
    { name: "No Type", url: "https://x.test/" },                                         // @type-less node with data keys
    { "@context": "https://schema.org", "@graph": [{ "@type": "WebSite", name: "NoFluff" }, { "@type": "BreadcrumbList", itemListElement: [] }] }, // NoFluffJobs metadata graph
    { "@type": "Organization", name: "Acme" },                                           // publisher metadata
    { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", name: "Home" }] },
    { "@type": "VideoObject", name: "Promo", description: "An embedded video." },        // media-embed metadata (re-opens the bug)
    { "@type": "AudioObject", name: "Track" },
    { "@type": "JobPosting" },                                                           // bare data type, no content field
    { "@type": ["WebPage", "JobPosting"], name: "shell" },                               // multi-type, no JobPosting content field
    { "@type": "Movie", name: "Inception" },                                             // name-only media (no description)
  ];
  for (const jsonLd of notSatisfying) {
    assert.equal(hasContentBearingJsonLd(jsonLd), false, `not satisfied: ${JSON.stringify(jsonLd)}`);
  }
});

// C3 — SocialMediaPosting is gate-scoped to pin-detail pages: an embedded post on an unrelated
// page does NOT satisfy (re-opens the bug off-pin); a pin-detail page DOES. (#152)
test("C3: SocialMediaPosting satisfies only on a pin-detail page", () => {
  const post = { "@type": "SocialMediaPosting", articleBody: "embedded social post caption" };
  assert.equal(hasContentBearingJsonLd(post, true), true, "satisfies on a pin-detail page");
  assert.equal(hasContentBearingJsonLd(post, false), false, "does NOT satisfy off-pin (embedded post ≠ page subject)");
});

// C4 — NESTED: a wrapper node reaches content via mainEntity / about / hasPart / itemListElement
// (a WebPage whose mainEntity is an Article; an ItemList of Articles); a non-content nest does not.
test("C4: nested content entities satisfy; non-content nests do not", () => {
  assert.equal(hasContentBearingJsonLd({ "@type": "WebPage", mainEntity: { "@type": "Article", headline: "real" } }), true);
  assert.equal(hasContentBearingJsonLd({ "@type": "ItemList", itemListElement: [{ "@type": "Product", description: "a widget" }] }), true);
  assert.equal(hasContentBearingJsonLd({ "@type": "WebPage", mainEntity: { "@type": "WebPage", name: "still meta" } }), false);
});

// C5 — #109 REVERSAL guard: a scaffolding WebPage with a real description no longer satisfies
// (the positive half of #109 is reversed; the negative half — empty description — still holds).
test("C5: #109 reversal — WebPage + a real description no longer satisfies", () => {
  assert.equal(hasContentBearingJsonLd({ "@type": "WebPage", description: "A real summary." }), false);
  assert.equal(hasContentBearingJsonLd({ "@type": "WebPage", description: "" }), false);
});

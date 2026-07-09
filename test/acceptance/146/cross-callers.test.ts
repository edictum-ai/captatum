// Frozen acceptance — #146 cross-caller coverage (spec criteria 10/11).
// stripHtmlTags has THREE production callers beyond extractVisibleText:
//   - application/use-cases/tier1-payload.ts:58  (stripHtml over JSON-LD description/articleBody)
//   - infrastructure/extract/metadata.ts:45       (title extraction)
//   - infrastructure/extract/svg-text.ts:59,64    (svg <text> labels)
// All three inherit the (C) quote-aware fix. These cases pin the fix THROUGH each integrated
// path so an implementation that special-cased only extractVisibleText (or one caller)
// cannot pass the frozen gate. Tier-3 rendered-HTML/svg coverage needs a browser and is
// deferred to the integration suite (test/integration/fixtures.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetcherResult } from "../../../src/application/ports/fetcher.ts";
import { extractTier1FromFetchResult } from "../../../src/application/use-cases/tier1-extract.ts";
import { extractHtml } from "../../../src/infrastructure/extract/index.ts";

function fetchResult(finalUrl: string, html: string, contentType = "text/html; charset=utf-8"): FetcherResult {
  return {
    status: 200,
    finalUrl,
    redirects: [],
    bodyStream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(html));
        controller.close();
      },
    }),
    contentType,
    bytes: Buffer.byteLength(html),
  };
}

// (C) via the tier1-payload JSON-LD path: a JobPosting description carrying an Alpine
// x-init directive with a quoted `>` must surface the description body, not the directive JS.
test("cross-caller #146-C (crit 10): tier1-payload stripHtml over a JSON-LD description with a quoted `>`", async () => {
  const description = '<div x-init="$nextTick(() => { if (a > b) { foo() } })">Senior Backend Engineer — the real JD body, substantial and complete.</div>';
  const html = '<!doctype html><html><head><title>Job</title></head><body>'
    + '<script type="application/ld+json">' + JSON.stringify({
      "@context": "https://schema.org", "@type": "JobPosting",
      title: "Senior Backend Engineer", description,
    }) + '</script></body></html>';
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://jobs.test/1",
    fetchResult: fetchResult("https://jobs.test/1", html),
    extractHtml,
    durationMs: 100,
    fetchMs: 90,
    output: "raw",
  });
  const out = (result.result ?? "").replace(/\s+/g, " ").trim();
  assert.ok(out.includes("Senior Backend Engineer"), "the JSON-LD description body is surfaced");
  assert.doesNotMatch(out, /if \(a > b\)|foo\(\)|x-init|\$nextTick/, "no directive JS leaks via tier1-payload stripHtml");
});

// (C) via the svg-text path: a child element inside <text> whose attribute carries a quoted
// `>` is cleaned — the label survives, no attr/markup leaks into the visible feed.
test("cross-caller #146-C (crit 10): svg-text label with a child tag carrying a quoted `>`", () => {
  const html = '<html><body><svg><text>Q1 <tspan data-x="a>b">Revenue</tspan></text></svg></body></html>';
  const text = extractHtml({ html, url: "https://charts.test/" }).text.replace(/\s+/g, " ").trim();
  assert.match(text, /Q1.*Revenue/, "the svg <text> label survives");
  assert.doesNotMatch(text, /data-x|a>b|tspan/, "no svg child attr/markup leaks via svg-text");
});

// (C) via the metadata title path: a <title> containing a tag with a quoted `>` is cleaned
// to its inner text (metadata.ts:45 → stripHtmlTags), no attr leak.
test("cross-caller #146-C (crit 10): metadata title with a quoted `>` tag is cleaned", () => {
  const html = '<html><head><title>Report <b data-x="a>b">Q2</b> Earnings</title></head>'
    + '<body><p>Earnings report body content here, substantial and complete.</p></body></html>';
  const title = (extractHtml({ html, url: "https://report.test/" }).title ?? "").replace(/\s+/g, " ").trim();
  assert.equal(title, "Report Q2 Earnings", "title reduced to its inner text with no attr leak");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { FetcherResult } from "../src/application/ports/fetcher.ts";
import { extractTier1FromFetchResult, preferredTitle } from "../src/application/use-cases/tier1-extract.ts";
import { extractHtml } from "../src/infrastructure/extract/index.ts";
import { extractVisibleText, stripHtmlComments, stripHtmlTags } from "../src/infrastructure/extract/html.ts";

const FIXTURE_DIR = join(process.cwd(), "test", "fixtures", "extract");

test("extracts title, canonical URL, and JSON-LD from json-ld.html", () => {
  const extraction = extractHtml({
    html: fixture("json-ld.html"),
    url: "https://example.test/articles/original",
  });

  assert.equal(extraction.title, "JSON-LD Fixture & Title");
  assert.equal(extraction.structured.canonicalUrl, "https://example.test/json-ld?ref=fixture");
  assert.deepEqual(extraction.structured.jsonLd, {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: "Deterministic extraction",
    author: { "@type": "Person", name: "Ada" },
  });
  assert.equal(extraction.shellGate.jsRequired, false);
  assert.equal(extraction.shellGate.reason, "structured-data-found");
  assert.deepEqual(extraction.errors, []);
});

test("extracts Open Graph, Twitter, generic meta, and canonical from og-meta.html", () => {
  const extraction = extractHtml({
    html: fixture("og-meta.html"),
    url: "https://example.test/start",
  });

  assert.equal(extraction.title, "Meta Fixture");
  assert.equal(extraction.structured.canonicalUrl, "https://example.test/meta-canonical?x=1&y=2");
  assert.deepEqual(extraction.structured.og, {
    "og:title": "OG Fixture Title",
    "og:type": "article",
    "og:url": "https://example.test/articles/fixture",
  });
  assert.deepEqual(extraction.structured.meta, {
    description: "A deterministic meta fixture.",
    "twitter:card": "summary_large_image",
    "twitter:title": "Twitter Fixture Title",
  });
  // OG/twitter meta alone (empty body, no JSON-LD/app-state) is a shell — render it.
  assert.equal(extraction.shellGate.reason, "empty-spa-shell");
});

test("ignores unsafe meta keys after normalization", () => {
  const extraction = extractHtml({
    html: [
      "<meta property=\"OG:TITLE\" content=\"Safe OG\">",
      "<meta name=\"description\" content=\"Safe meta\">",
      "<meta name=\"Constructor\" content=\"unsafe\">",
      "<meta name=\"PROTOTYPE\" content=\"unsafe\">",
      "<meta name=\"__PROTO__\" content=\"unsafe\">",
    ].join(""),
    url: "https://example.test/meta-unsafe",
  });

  assert.deepEqual(extraction.structured.og, { "og:title": "Safe OG" });
  assert.deepEqual(extraction.structured.meta, { description: "Safe meta" });
  assert.equal(extraction.shellGate.reason, "empty-spa-shell");
});

test("extracts __NEXT_DATA__ and __INITIAL_STATE__ from app-state.html", () => {
  const extraction = extractHtml({
    html: fixture("app-state.html"),
    url: "https://example.test/app-state",
  });

  assert.deepEqual(extraction.structured.appState, {
    __NEXT_DATA__: {
      props: { pageProps: { slug: "tier-1", count: 2 } },
      page: "/docs/[slug]",
    },
    __INITIAL_STATE__: {
      viewer: { name: "Reader", roles: ["agent", "tester"] },
      nested: { message: "brace } inside string" },
    },
  });
  assert.equal(extraction.shellGate.reason, "structured-data-found");
});

test("shell gate distinguishes content-page.html from spa-shell.html", () => {
  const content = extractHtml({
    html: fixture("content-page.html"),
    url: "https://example.test/content",
  });
  const shell = extractHtml({
    html: fixture("spa-shell.html"),
    url: "https://example.test/app",
  });

  assert.equal(content.shellGate.jsRequired, false);
  assert.equal(content.shellGate.reason, "content-present");
  assert.equal(content.text, [
    "Tier one extraction has real content",
    "This fixture has enough visible text for the shell gate to stop before render.",
  ].join(" "));

  assert.equal(shell.shellGate.jsRequired, true);
  assert.equal(shell.shellGate.reason, "empty-spa-shell");
  assert.equal(shell.shellGate.appRootFound, true);
  assert.equal(shell.shellGate.scriptCount, 2);
  assert.equal(shell.text, "");
});

test("shell gate escalates an OG-tagged SPA with an empty body (regression: vue-realworld, react-shopping-cart)", () => {
  // Real failure: an SPA ships og:title + an app-root div + a JS bundle but no
  // body text. OG is social-card metadata, not content — this must render.
  const extraction = extractHtml({
    html: [
      "<html><head>",
      "<title>Conduit</title>",
      "<meta property=\"og:title\" content=\"Conduit\">",
      "<meta property=\"og:type\" content=\"website\">",
      "</head><body>",
      "<div id=\"app\"></div>",
      "<script src=\"/bundle.js\"></script>",
      "</body></html>",
    ].join(""),
    url: "https://example.test/spa-with-og",
  });

  assert.equal(extraction.shellGate.jsRequired, true);
  assert.equal(extraction.shellGate.reason, "empty-spa-shell");
  assert.equal(extraction.shellGate.appRootFound, true);
  assert.ok(extraction.structured.og, "OG still extracted");
});

test("prototype-pollution.html drops unsafe app-state keys without mutating prototypes", () => {
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const extraction = extractHtml({
    html: fixture("prototype-pollution.html"),
    url: "https://example.test/pollution",
  });

  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.deepEqual(extraction.structured.appState, {
    __NEXT_DATA__: {
      props: {
        pageProps: {
          safe: true,
          nested: { kept: "value" },
        },
      },
    },
  });
  assert.deepEqual(
    extraction.errors.map((error) => error.code),
    ["unsafe_json_key", "unsafe_json_key", "unsafe_json_key"],
  );
});

test("malformed.html returns partial structured data instead of throwing", () => {
  const extraction = extractHtml({
    html: fixture("malformed.html"),
    url: "https://example.test/malformed",
  });

  assert.equal(extraction.title, "Malformed Fixture");
  assert.deepEqual(extraction.structured.og, { "og:title": "Recovered OG" });
  assert.deepEqual(extraction.structured.jsonLd, {
    "@context": "https://schema.org",
    "@type": "Thing",
    name: "Recovered",
  });
  assert.equal(extraction.text, "Recovered body text despite missing closing tags");
  assert.equal(extraction.shellGate.reason, "structured-data-found");
});

test("Tier-1 use case returns Result-compatible structured data and shell evidence", async () => {
  const result = await extractTier1FromFetchResult({
    requestedUrl: "https://example.test/requested",
    fetchResult: fetchResult("https://example.test/app", fixture("spa-shell.html")),
    extractHtml,
    durationMs: 12,
    fetchMs: 8,
    output: "raw",
    fetchedAt: "2026-06-16T00:00:00.000Z",
  });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.url, "https://example.test/requested");
  assert.equal(result.finalUrl, "https://example.test/app");
  assert.equal(result.tier, 1);
  assert.equal(result.output, "raw");
  assert.equal(result.jsRequired, true);
  assert.equal(result.resolvedVia, "tier1-shell-gate");
  assert.deepEqual(result.attempts, [{
    step: 1,
    tier: 1,
    outcome: "escalate",
    status: 200,
    durationMs: 8,
    bytes: Buffer.byteLength(fixture("spa-shell.html")),
    reason: "empty-spa-shell",
  }]);
  assert.deepEqual(result.structured, {
    meta: { viewport: "width=device-width, initial-scale=1" },
  });
  assert.equal(result.result, "");
  assert.equal(JSON.stringify(result).includes("Set-Cookie"), false);
  assert.equal(JSON.stringify(result).includes("Authorization"), false);
});

test("preferredTitle uses a content-bearing JSON-LD title when <title> is generic", () => {
  // e2b-style iframe case: host page <title> is "Careers — E2B" but the
  // embedded JobPosting JSON-LD carries the real title.
  const iframe = preferredTitle("Careers — E2B", {
    jsonLd: { "@type": "JobPosting", title: "Platform Engineer" },
  });
  assert.equal(iframe, "Platform Engineer");

  // Ashby direct: <title> already contains the JSON-LD title and is richer,
  // so the <title> is kept.
  const ashby = preferredTitle("Platform Engineer @ E2B", {
    jsonLd: { "@type": "JobPosting", title: "Platform Engineer" },
  });
  assert.equal(ashby, "Platform Engineer @ E2B");

  // Homepage with an Organization node: Organization is not a content type, so
  // the page <title> is preserved over the generic org name.
  const home = preferredTitle("E2B — Sandboxes for AI agents", {
    jsonLd: { "@type": "Organization", name: "E2B" },
  });
  assert.equal(home, "E2B — Sandboxes for AI agents");

  // headline + @graph wrapper.
  const graph = preferredTitle("Site Name", {
    jsonLd: { "@graph": [{ "@type": "NewsArticle", headline: "Breaking Story" }] },
  });
  assert.equal(graph, "Breaking Story");

  // Full-IRI @type form (https://schema.org/JobPosting).
  const iri = preferredTitle("Generic", {
    jsonLd: { "@type": "https://schema.org/JobPosting", title: "Platform Engineer" },
  });
  assert.equal(iri, "Platform Engineer");

  // Single-object @graph wrapper (not an array).
  const singleGraph = preferredTitle("Site", {
    jsonLd: { "@graph": { "@type": "NewsArticle", headline: "Solo Graph Story" } },
  });
  assert.equal(singleGraph, "Solo Graph Story");

  // Multiple content-bearing nodes: first in document order wins (the page's
  // primary content). This is a deliberate heuristic, locked here intentionally.
  const multi = preferredTitle("Site", {
    jsonLd: [
      { "@type": "NewsArticle", headline: "First Story Wins" },
      { "@type": "JobPosting", title: "Some Job" },
    ],
  });
  assert.equal(multi, "First Story Wins");

  // No structured data: <title> passes through.
  assert.equal(preferredTitle("Just a title", {}), "Just a title");
  assert.equal(preferredTitle(undefined, {}), undefined);
});

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

function fetchResult(finalUrl: string, html: string): FetcherResult {
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
    contentType: "text/html; charset=utf-8",
    bytes: Buffer.byteLength(html),
  };
}

// REDOS-1/2/3: the extraction regexes were quadratic on pathological HTML
// (unterminated `<!--`, bare-`<` flood, unterminated `<script>`). The linear
// scanners are O(n); these guard against a quadratic regression and pin the
// spacing / close-tag-boundary behavior the old regexes had.
test("stripHtmlTags scales linearly on a bare-`<` flood (REDOS-2)", () => {
  assert.equal(stripHtmlTags("<".repeat(1000)), "<".repeat(1000)); // no '>' → literal
  // CI-independent regression guard: a 4x input must take ~4x (linear), not ~16x
  // (quadratic). Ratio avoids flaking on slow/loaded runners, unlike a fixed
  // wall-clock budget.
  const timed = (n: number): number => {
    const t = performance.now();
    stripHtmlTags("<".repeat(n));
    return performance.now() - t;
  };
  timed(200_000); // JIT warmup
  const ratio = timed(800_000) / Math.max(timed(200_000), 1);
  assert.ok(ratio < 8, `stripHtmlTags 800k/200k ratio ${ratio.toFixed(1)} — likely quadratic`);
});

test("stripHtmlTags replaces tags with spaces so words don't merge", () => {
  const out = stripHtmlTags("<a>x</a><b>y</b>");
  assert.doesNotMatch(out, /xy/, "adjacent tags must not merge their text");
  assert.match(out, /x/);
  assert.match(out, /y/);
});

test("stripHtmlComments is linear on unterminated `<!--` and replaces with a space", () => {
  assert.equal(stripHtmlComments("<!--".repeat(50_000)), " "); // no '-->' → stop
  assert.equal(stripHtmlComments("a<!-- c -->b"), "a b");
});

test("extractVisibleText completes on pathological floods without hanging (REDOS-1/2/3)", () => {
  const pathological = `<html><body>${"<script>".repeat(20_000)}${"<!--".repeat(20_000)}${"<".repeat(20_000)}</body></html>`;
  assert.equal(typeof extractVisibleText(pathological), "string");
});

test("extractVisibleText separates words across tags (no merge regression)", () => {
  const text = extractVisibleText("<html><body><h1>Heading</h1><p>Hello</p></body></html>");
  assert.match(text, /Heading Hello/, "a space where each tag was");
});

test("extractVisibleText rejoins inline-split prices without merging lists/periods", () => {
  // `<span>$</span><span>10</span><span>.90</span>` -> "$ 10 .90" (each tag became
  // a space) -> "$10.90".
  assert.equal(extractVisibleText("<p><span>$</span><span>10</span><span>.90</span></p>"), "$10.90");
  const mixed = extractVisibleText("<p>Total 10 .90; list 10, 20, 30. End. Next.</p>");
  assert.match(mixed, /Total 10\.90;/, "decimal fragment rejoined");
  assert.match(mixed, /10, 20, 30/, "comma list preserved");
  assert.match(mixed, /End\. Next\./, "sentence periods preserved");
});

test("extractVisibleText does not treat </scripture> as a </script> close", () => {
  const html = `<html><body><script>var s = "</scripture>";</script><p>Visible</p></body></html>`;
  const text = extractVisibleText(html);
  assert.match(text, /Visible/);
  assert.doesNotMatch(text, /scripture|var s/i, "script content removed via the real </script> close");
});

test("extractVisibleText still strips script/style/comments/tags on well-formed HTML", () => {
  const html = `<html><head><style>.x{color:red}</style></head><body><script>var x=1;</script><!-- note --><h1>Heading</h1><p>Hello &amp; world</p></body></html>`;
  const text = extractVisibleText(html);
  assert.match(text, /Heading/);
  assert.match(text, /Hello & world/);
  assert.doesNotMatch(text, /var x|note|color:red/, "script/style/comment content removed");
});

test("extractHtml scales linearly on a <title> bare-`<` flood (REDOS-2 in metadata.ts)", () => {
  const html = (n: number): string => `<html><head><title>${"<".repeat(n)}</title></head><body>x</body></html>`;
  // CI-independent regression guard (see stripHtmlTags test): 4x input must cost
  // ~4x, not ~16x. Smaller sizes than the stripHtmlTags test — extractHtml does
  // more work per character.
  const timed = (n: number): number => {
    const t = performance.now();
    extractHtml({ html: html(n), url: "https://example.test/" });
    return performance.now() - t;
  };
  timed(50_000); // JIT warmup
  const ratio = timed(200_000) / Math.max(timed(50_000), 1);
  assert.equal(typeof extractHtml({ html: html(100), url: "https://example.test/" }).title, "string");
  assert.ok(ratio < 8, `extractHtml title 200k/50k ratio ${ratio.toFixed(1)} — likely quadratic`);
});

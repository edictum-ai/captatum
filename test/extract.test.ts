import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { FetcherResult } from "../src/application/ports/fetcher.ts";
import { extractTier1FromFetchResult, preferredTitle } from "../src/application/use-cases/tier1-extract.ts";
import { extractHtml } from "../src/infrastructure/extract/index.ts";

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
  assert.equal(extraction.shellGate.reason, "structured-data-found");
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
  assert.equal(extraction.shellGate.reason, "structured-data-found");
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

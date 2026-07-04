import assert from "node:assert/strict";
import { test } from "node:test";
import type { StructuredData } from "../src/domain/platform.ts";
import { extractHtml, hasUsableStructuredData } from "../src/infrastructure/extract/index.ts";

// #81: an empty / trivial JSON-LD block ([], {}, null, or a context-only node) must NOT
// satisfy the shell-gate. Otherwise a client-rendered SPA that ships one stops at Tier-1
// and returns EMPTY content instead of rendering. These drive the real extractHtml path
// (HTML in → gate decision out), not a hand-mocked structured object.

test("shell-gate: empty JSON-LD does not stop an empty SPA shell from rendering (#81)", () => {
  const shell = '<html><body><div id="root"></div><script type="application/ld+json">[]</script></body></html>';
  const gate = extractHtml({ html: shell, url: "https://spa.test/" }).shellGate;
  assert.equal(gate.jsRequired, true, "empty ld+json array must not satisfy the gate");
  assert.equal(gate.reason, "empty-spa-shell");
});

test("shell-gate: context-only JSON-LD does not stop an empty SPA shell (#81)", () => {
  const shell = '<div id="root"></div><script type="application/ld+json">{"@context":"https://schema.org"}</script>';
  assert.equal(extractHtml({ html: shell, url: "https://spa.test/" }).shellGate.jsRequired, true);
});

test("shell-gate: real typed JSON-LD still resolves at Tier-1, no render (#81 regression guard)", () => {
  const html = '<html><body><div id="root"></div><script type="application/ld+json">'
    + '{"@context":"https://schema.org","@type":"JobPosting","title":"Engineer"}</script></body></html>';
  const gate = extractHtml({ html, url: "https://spa.test/" }).shellGate;
  assert.equal(gate.jsRequired, false);
  assert.equal(gate.reason, "structured-data-found");
});

test("shell-gate: real body text + empty JSON-LD resolves via content-present, no render (#81)", () => {
  const html = "<html><body><article>" + "Real visible article content here. ".repeat(5)
    + '</article><script type="application/ld+json">[]</script></body></html>';
  const gate = extractHtml({ html, url: "https://x.test/" }).shellGate;
  assert.equal(gate.jsRequired, false);
  assert.equal(gate.reason, "content-present");
});

test("hasUsableStructuredData: content-bearing JSON-LD predicate edge cases (#81)", () => {
  const notUsable: unknown[] = [null, [], {}, { "@context": "https://schema.org" }, [{ "@context": "x" }], { "@graph": [] }];
  for (const jsonLd of notUsable) {
    assert.equal(hasUsableStructuredData({ jsonLd } as StructuredData), false, `not usable: ${JSON.stringify(jsonLd)}`);
  }
  const usable: unknown[] = [
    { "@type": "Article", headline: "x" },
    [{ "@type": "Product" }],
    { "@context": "x", "@graph": [{ "@type": "Article", headline: "y" }] },
  ];
  for (const jsonLd of usable) {
    assert.equal(hasUsableStructuredData({ jsonLd } as StructuredData), true, `usable: ${JSON.stringify(jsonLd)}`);
  }
});

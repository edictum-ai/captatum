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

// #92: a non-HTML body is the COMPLETE response however short — it must NEVER be judged an
// empty SPA shell needing JS. Without the content-type guard, a 14-byte text/plain
// "404: Not Found" tripped hasContent's <20-byte rule and escalated to jsRequired, cascading
// to contentType="spa" + gateReason="js-required" + tier="render-blocked" — a receipt that lies.

test("shell-gate: a short text/plain body is content, not an empty SPA shell (#92)", () => {
  const gate = extractHtml({ html: "404: Not Found", url: "https://x.test/missing", contentType: "text/plain; charset=utf-8" }).shellGate;
  assert.equal(gate.jsRequired, false, "a text/plain body, however short, is not a render shell");
  assert.equal(gate.reason, "content-present");
});

test("shell-gate: a short application/json body is content, not an empty SPA shell (#92)", () => {
  const gate = extractHtml({ html: '{"ok":false}', url: "https://x.test/api", contentType: "application/json" }).shellGate;
  assert.equal(gate.jsRequired, false);
  assert.equal(gate.reason, "content-present");
});

test("shell-gate: ABSENT content-type still escalates a genuinely empty HTML shell (no #92 regression)", () => {
  const gate = extractHtml({ html: '<div id="root"></div>', url: "https://spa.test/" }).shellGate;
  assert.equal(gate.jsRequired, true, "an empty shell with no declared type still needs render");
  assert.equal(gate.reason, "empty-spa-shell");
});

// #92 review (codex P2): once a non-HTML body is treated as complete content, extractHtml must
// return the RAW decoded body — not the HTML-stripped text, which mangles angle-bracket data.

test("extractHtml preserves a non-HTML body verbatim, including angle-bracket data (#92 review)", () => {
  const out = extractHtml({ html: '{"x":"<b>hi</b>"}', url: "https://x.test/api", contentType: "application/json" });
  assert.equal(out.text, '{"x":"<b>hi</b>"}', "JSON angle-bracket data must not be HTML-stripped");
  assert.equal(out.shellGate.jsRequired, false);
});

test("extractHtml preserves newlines in text/markdown bodies (#92 review, covers #94 markdown half)", () => {
  const md = "# Title\n\nfirst paragraph\n\nsecond paragraph";
  const out = extractHtml({ html: md, url: "https://x.test/readme.md", contentType: "text/markdown" });
  assert.equal(out.text, md, "markdown newlines must be preserved, not collapsed");
});

test("extractHtml preserves edge whitespace verbatim in non-HTML bodies (#92 review)", () => {
  // Leading indentation and trailing newlines are meaningful in code/markdown — the raw body must
  // be returned unchanged, not trimmed.
  const body = "    indented first line\nbody\n  \n";
  const out = extractHtml({ html: body, url: "https://x.test/snippet.txt", contentType: "text/plain" });
  assert.equal(out.text, body, "non-HTML edge whitespace must be preserved verbatim");
  assert.equal(out.shellGate.jsRequired, false);
});

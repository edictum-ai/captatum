import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { extractHtml } from "../src/infrastructure/extract/index.ts";
import { findElements } from "../src/infrastructure/extract/html.ts";
import { collectHiddenDisplayNoneClasses } from "../src/infrastructure/extract/hidden-classes.ts";
import { inlineSvgText } from "../src/infrastructure/extract/svg-text.ts";

// REDOS-5 regression: HTML extraction scanners must be LINEAR, not quadratic. The
// old per-tag `indexOf("</tag", tag.end)` rescanned to EOS for every opener, so an
// unclosed-same-tag flood (≤ the 1 MB EXTRACT_CHAR_BUDGET) stalled the synchronous
// Node event loop for tens of seconds — taking down the whole hosted server. A green
// synthetic fixture missed the original bug; these flood the REAL input (125k openers,
// ~750 KB–1 MB) and assert a wall-clock bound a linear pass clears easily but a
// quadratic regression misses by 1000×+.

const FLOOD = 125_000; // "<script>".repeat(125000) ≈ 1 MB, the EXTRACT_CHAR_BUDGET ceiling
// Wall-clock bounds a LINEAR pass clears with room to spare but a quadratic regression
// (tens of seconds on this input) misses by 10×+. Sized to each scanner's real linear
// COST, not shaved to the millisecond. DIRECT_MS is for a single-pass scanner
// (findElements); MULTI_PASS_MS covers scanners that make several passes over 1 MB AND
// parse attributes on 125k tags — collectHiddenDisplayNoneClasses strips
// script/noscript/template + comments first; inlineSvgText strips defs/symbol + builds
// 125k <text> tags. Those are genuinely linear but a higher constant, so a 500 ms
// micro-bound flaked on a slow shared runner (~520–588 ms) even though the full
// multi-scanner pipeline stays under ENDE_TO_END_MS — still ~12×+ under a quadratic.
const DIRECT_MS = 500;
const MULTI_PASS_MS = 2500;
const ENDE_TO_END_MS = 3000;

function timed<T>(label: string, limitMs: number, fn: () => T): T {
  const start = performance.now();
  const out = fn();
  const ms = performance.now() - start;
  assert.ok(ms < limitMs, `${label} took ${ms.toFixed(1)}ms (limit ${limitMs}ms) — likely quadratic (REDOS-5) regression`);
  return out;
}

test("findElements is linear on an unclosed <script> flood (REDOS-5)", () => {
  const html = "<script>".repeat(FLOOD);
  const elements = timed("findElements(script)", DIRECT_MS, () => findElements(html, "script"));
  assert.ok(elements.length >= 1, "an opener with no close still yields its run-to-EOS element");
});

test("findElements is linear on an unclosed <body> flood (REDOS-5)", () => {
  const html = "<body>".repeat(FLOOD);
  const elements = timed("findElements(body)", DIRECT_MS, () => findElements(html, "body"));
  assert.ok(elements.length >= 1);
});

test("collectHiddenDisplayNoneClasses is linear on a <style> flood (REDOS-5)", () => {
  const html = "<style>".repeat(FLOOD);
  timed("collectHiddenDisplayNoneClasses", MULTI_PASS_MS, () => collectHiddenDisplayNoneClasses(html));
});

test("inlineSvgText is linear on a closed <svg> whose body is a <text> flood (REDOS-5)", () => {
  // The svg must be CLOSED so inlineSvgText reaches collectSvgTextElements; an
  // unclosed svg returns early before the <text> scan.
  const html = `<svg>${"<text>".repeat(FLOOD)}</svg>`;
  timed("inlineSvgText", MULTI_PASS_MS, () => inlineSvgText(html));
});

test("findElements does not treat </scripture> as a </script> close (boundary check)", () => {
  // A real HTML5 parser ends script data only at a tag-boundary `</script>`; the
  // `</script` inside `</scripture>` must not truncate the JSON-LD content.
  const html = `<script type="application/ld+json">{"description":"see </scripture> for details"}</script>`;
  const elements = findElements(html, "script");
  assert.ok(
    elements[0]?.content.includes('"see </scripture> for details"'),
    "</scripture> inside a JSON string must not be treated as the script close",
  );
});

test("extractHtml (full pipeline) is linear on a <script> flood (REDOS-5)", () => {
  const html = "<script>".repeat(FLOOD);
  timed("extractHtml(script-flood)", ENDE_TO_END_MS, () =>
    extractHtml({ html, url: "https://example.test/" }),
  );
});

test("extractHtml (full pipeline) is linear on a <style> flood (REDOS-5)", () => {
  const html = "<style>".repeat(FLOOD);
  timed("extractHtml(style-flood)", ENDE_TO_END_MS, () =>
    extractHtml({ html, url: "https://example.test/" }),
  );
});

test("normal extraction output is unchanged by the linearization", () => {
  // Well-formed input exercises every fixed scanner along its happy path: JSON-LD +
  // app-state via findElements("script"), title, body, a display:none class from a
  // <style> block, and a <text> label inside a closed <svg>.
  const html = [
    "<html><head>",
    "<title>Job - Test Page</title>",
    `<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Engineer"}</script>`,
    "<style>.secret{display:none} .shown{display:block}</style>",
    "</head><body>",
    `<div class="secret">SHOULD_NOT_APPEAR</div>`,
    `<p>Hello visible world</p>`,
    `<svg><text>Chart label: $5</text></svg>`,
    "</body></html>",
  ].join("");
  // extractHtml returns the raw <title> directly; the JSON-LD-title preference is
  // applied upstream in extractTier1FromFetchResult, so assert the JSON-LD node was
  // harvested into structured data (the findElements("script") path) rather than the
  // preferred title.
  const extraction = extractHtml({ html, url: "https://example.test/" });
  assert.equal(extraction.title, "Job - Test Page", "raw <title> is returned");
  assert.ok(
    JSON.stringify(extraction.structured).includes("Engineer"),
    "JSON-LD script content is parsed into structured data",
  );
  assert.ok(extraction.text.includes("Hello visible world"), "visible body text survives");
  assert.ok(extraction.text.includes("Chart label: $5"), "svg <text> data is inlined");
  assert.ok(!extraction.text.includes("SHOULD_NOT_APPEAR"), "display:none class content is stripped");
});

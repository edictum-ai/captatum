import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { extractHtml } from "../src/infrastructure/extract/index.ts";
import { findElements } from "../src/infrastructure/extract/html.ts";
import { collectHiddenDisplayNoneClasses } from "../src/infrastructure/extract/hidden-classes.ts";
import { inlineSvgText } from "../src/infrastructure/extract/svg-text.ts";

// REDOS-5 regression guard: the HTML extraction scanners must be LINEAR, not
// quadratic. The old per-tag `indexOf("</tag", tag.end)` rescanned to EOS for
// every opener, so an unclosed-same-tag flood (≤ the 1 MB EXTRACT_CHAR_BUDGET)
// stalled the synchronous Node event loop for tens of seconds — taking down the
// whole hosted server. A green synthetic fixture missed the original bug.
//
// Flakiness history (#124): an earlier version asserted an ABSOLUTE wall-clock
// budget (3000ms). That is runner-dependent — CI hit 3004ms on a slow shared
// runner, then re-ran green, derailing the 0.11.3 release CI. The timing tests
// now use TWO runner-relative assertions measured on the SAME run, so a slow
// runner (which slows every operation proportionally) cannot flake them:
//
//   1. LINEARITY (primary): wall-clock at a 10× larger input must be < LIN_RATIO×
//      the small input's time. Linear ⇒ ratio ≲ 10 (+ noise); the quadratic bug
//      ⇒ ratio ≈ 100 (work scales with bytes²). LIN_RATIO = 40 sits in the wide
//      gap — ~3-4× above the linear ceiling, ~2.5× below quadratic — robust to
//      GC/scheduler noise on either side. A knife-edge absolute bound has no such
//      gap; a ratio does, which is why it cannot flake the way 3000ms did.
//   2. CONSTANT-FACTOR (secondary): a generous absolute ceiling catches a LINEAR
//      but pathologically slow regression the ratio MISSES (a constant blow-up
//      inflates both sizes equally, so the ratio stays ~10). Set ~10× the healthy
//      time, so it never flakes on runner variance — it fires only on a real
//      pathology (the quadratic flood takes tens of seconds).
//
// Both sizes stay under EXTRACT_CHAR_BUDGET, so extraction never truncates mid-scan
// (which would skew the ratio). SMALL/LARGE are 100 KB / 1 MB at 8 bytes/opener.

const SMALL = 12_500; // 10× smaller than LARGE; large enough to time reliably
const LARGE = 125_000; // "<script>".repeat(125000) ≈ 1 MB = EXTRACT_CHAR_BUDGET ceiling
const LIN_RATIO = 40; // linear ≲ 10 (+noise) vs quadratic ≈ 100, at 10× input
// ~10× the observed healthy time on a slow runner. A quadratic flood is tens of
// seconds, so these only fire on a real pathology — never on normal variance.
const DIRECT_CEILING_MS = 5_000; // single-pass scanner (findElements)
const MULTI_CEILING_MS = 25_000; // multi-pass / full-pipeline scanner

/** Wall-clock `fn()` in ms (single shot). */
function timedMs<T>(fn: () => T): { ms: number; out: T } {
  const start = performance.now();
  const out = fn();
  return { ms: performance.now() - start, out };
}

/**
 * Assert `fn` is LINEAR on `build`'s output and bounded in absolute time.
 * Runs SMALL then LARGE on the same runner and returns LARGE's result so the
 * caller can assert correctness on the real (1 MB) input. (REDOS-5)
 */
function assertLinear<T>(
  label: string,
  build: (openers: number) => string,
  fn: (html: string) => T,
  ceilingMs: number,
): T {
  const { ms: tSmall } = timedMs(() => fn(build(SMALL)));
  const { ms: tLarge, out } = timedMs(() => fn(build(LARGE)));
  // Primary: linear, not quadratic. tSmall floored at 0.1ms so a sub-millisecond
  // small run can't blow the ratio up on its own.
  const ratio = tLarge / Math.max(tSmall, 0.1);
  assert.ok(
    ratio < LIN_RATIO,
    `${label}: ${LARGE}/${SMALL} input ratio ${ratio.toFixed(1)}× (linear ≲ 10, quadratic ≈ 100) — likely a REDOS-5 regression ` +
      `(tSmall=${tSmall.toFixed(1)}ms, tLarge=${tLarge.toFixed(1)}ms)`,
  );
  // Secondary: bounded absolute time (catches a constant-factor blow-up the ratio misses).
  assert.ok(
    tLarge < ceilingMs,
    `${label}: tLarge ${tLarge.toFixed(1)}ms exceeded the ${ceilingMs}ms ceiling — pathological slowdown`,
  );
  return out;
}

test("findElements is linear on an unclosed <script> flood (REDOS-5)", () => {
  const elements = assertLinear(
    "findElements(script)",
    (n) => "<script>".repeat(n),
    (html) => findElements(html, "script"),
    DIRECT_CEILING_MS,
  );
  assert.ok(elements.length >= 1, "an opener with no close still yields its run-to-EOS element");
});

test("findElements is linear on an unclosed <body> flood (REDOS-5)", () => {
  const elements = assertLinear(
    "findElements(body)",
    (n) => "<body>".repeat(n),
    (html) => findElements(html, "body"),
    DIRECT_CEILING_MS,
  );
  assert.ok(elements.length >= 1);
});

test("collectHiddenDisplayNoneClasses is linear on a <style> flood (REDOS-5)", () => {
  // collectHiddenDisplayNoneClasses strips script/noscript/template + comments
  // first, then parses attributes on the surviving <style> openers — several
  // passes over 1 MB, so a genuinely linear but higher constant than findElements.
  assertLinear(
    "collectHiddenDisplayNoneClasses",
    (n) => "<style>".repeat(n),
    (html) => collectHiddenDisplayNoneClasses(html),
    MULTI_CEILING_MS,
  );
});

test("inlineSvgText is linear on a closed <svg> whose body is a <text> flood (REDOS-5)", () => {
  // The svg must be CLOSED so inlineSvgText reaches collectSvgTextElements; an
  // unclosed svg returns early before the <text> scan. It strips defs/symbol and
  // builds 125k <text> tags — linear but a higher constant.
  assertLinear(
    "inlineSvgText",
    (n) => `<svg>${"<text>".repeat(n)}</svg>`,
    (html) => inlineSvgText(html),
    MULTI_CEILING_MS,
  );
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
  assertLinear(
    "extractHtml(script-flood)",
    (n) => "<script>".repeat(n),
    (html) => extractHtml({ html, url: "https://example.test/" }),
    MULTI_CEILING_MS,
  );
});

test("extractHtml (full pipeline) is linear on a <style> flood (REDOS-5)", () => {
  assertLinear(
    "extractHtml(style-flood)",
    (n) => "<style>".repeat(n),
    (html) => extractHtml({ html, url: "https://example.test/" }),
    MULTI_CEILING_MS,
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

// REDOS-6 (#160 codex r15): the nesting-aware chrome strip's findMatchingClose must be LINEAR on
// deeply nested same-tag chrome. The old per-open findCloseTag rescanned the same suffix for each
// depth level → O(n²) — 13.6s on 51,200 nested <nav> tags. The batch-opens fix makes it O(n).
test("extractHtml is linear on deeply nested <nav> chrome (REDOS-6)", () => {
  assertLinear(
    "extractHtml(nested-nav-flood)",
    (n) => "<nav>".repeat(n) + "</nav>".repeat(n),
    (html) => extractHtml({ html, url: "https://nav-flood.test/" }),
    MULTI_CEILING_MS,
  );
});

// FROZEN acceptance suite for #165 — main-content container selection on the no-landmark
// path (cppreference/php.net lead chrome). Authored by a DIFFERENT harness than the
// implementer; pins the CONTRACT, not the implementation. Effects-only: every assertion
// checks the OUTPUT TEXT (chrome dropped, prose leads) or the shell-gate verdict — NEVER
// the internal selector chosen or the floor constants (those are impl-detail and live in
// non-frozen test/*.test.ts per the #151 lesson). Fixtures use realistic selectors
// (#content, #layout-content, .entry-content) only to CONSTRUCT the scenario; assertions
// read result.text / result.shellGate.jsRequired.
//
// Spec: docs/specs/165-no-landmark-content-container.md
// Entrypoint under test: extractHtml (src/infrastructure/extract/index.ts).
//
// Pre-implementation expectations (PR A ships this suite inactive via phases.json "165":
// false; PR B flips it true). These are stated so the reviewer can confirm the suite bites
// on the ASSERTION, not on a type/import error:
//   FAIL pre-impl — C1/C2/C3: today a no-landmark page scopes visible text to the whole
//     chrome-stripped body (stripChromeFromRaw: aside/nav only), so bare-<div>/<ul> top-bar
//     chrome — which no <aside>/<nav>/<footer> delimits — SURVIVES and leads result.text
//     ahead of the article. Both "chrome not in head" and "prose leads" bite on the output.
//   PASS pre-impl (fail-safe, unchanged) — C4/C5: no recognized container / a below-floor
//     minority container already resolve to the whole body today; the "real content
//     survives" assertions hold now and must keep holding (no-loss guard).
//   PASS pre-impl (regression guard) — C6: container selection must NOT flip the shell gate.
//     A short <div id="content">Loading</div> shell sits below the selection floor AND below
//     hasContent's 80-char threshold (7 < 20 → false) → still escalates (jsRequired:true);
//     a real-text container carries content → jsRequired:false either way. Green today; it
//     catches an implementation that BREAKS escalation.
//   PASS pre-impl — C7: a semantic <article> landmark already wins today (landmark >
//     container precedence), so its content leads and the sibling container's does not.
//   PASS pre-impl — C8: the no-landmark fallback keeps <footer> (stripChromeFromRaw strips
//     aside/nav only), so footer text survives now and must keep surviving.
//
// Normalization: extractVisibleText collapses inter-tag whitespace, but exact text shape is
// spacing-fragile, so "prose leads" cases normalize via `norm` and assert on the HEAD of
// the text; "chrome dropped" uses doesNotMatch on that same head so a leaked fragment is
// caught regardless of spacing.

import assert from "node:assert/strict";
import { test } from "node:test";
import { extractHtml, type HtmlExtractionInput } from "../../../src/infrastructure/extract/index.ts";

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
const headOf = (s: string, n = 50): string => norm(s).slice(0, n);
const page = (body: string): string => `<html><body>${body}</body></html>`;
const extract = (html: string) =>
  extractHtml({
    html,
    url: "https://example.test/page",
    contentType: "text/html; charset=utf-8",
  } satisfies HtmlExtractionInput);

// Shared fixtures. Chrome blocks are bare <div>/<ul> (NOT wrapped in <nav>/<aside>/<footer>)
// so they survive stripChromeFromRaw today and lead the text pre-impl — the named repro
// shape. Each chrome is > 50 chars so it fills the head window pre-impl. Content blocks are
// sized to hold the LARGE MAJORITY of the body text (well above the 0.7 selection fraction
// and the 200-char floor) so C1/C2/C3 exercise the SELECT path, not the reject path.

const CPPR_CHROME =
  `<div id="mw-head"><ul>` +
  `<li><a href="/s">Search</a></li><li><a href="/ca">Create account</a></li>` +
  `<li><a href="/li">Log in</a></li><li><a href="/ns">Namespaces</a></li>` +
  `<li><a href="/p">Page</a></li><li><a href="/d">Discussion</a></li>` +
  `<li><a href="/v">Variants</a></li><li><a href="/vw">Views</a></li>` +
  `</ul></div>`;
const CPPR_CONTENT =
  `<div id="content"><h1>std::sort</h1>` +
  `<p>From cppreference.com</p>` +
  `<p>Defined in header &lt;algorithm&gt;.</p>` +
  `<p>Sorts the elements in the range [first, last) in ascending order. The order of equal ` +
  `elements is not guaranteed to be preserved unless a stable comparator is used. The ` +
  `complexity is O(N log N) comparisons, where N is the distance between first and last.</p>` +
  `<p>Returns an iterator to the new location of the element that was at the original position.</p>` +
  `</div>`;

const PHP_CHROME =
  `<div class="topnav"><ul>` +
  `<li><a href="/d">Downloads</a></li><li><a href="/dc">Documentation</a></li>` +
  `<li><a href="/gi">Get Involved</a></li><li><a href="/cm">Community</a></li>` +
  `<li><a href="/n">News</a></li><li><a href="/a">Archive</a></li><li><a href="/h">Help</a></li>` +
  `</ul></div>`;
const PHP_CONTENT =
  `<section id="layout-content"><h2 class="title">strpos</h2>` +
  `<p>(PHP 4, PHP 5, PHP 7, PHP 8) strpos — Find the position of the first occurrence of a ` +
  `substring in a string.</p>` +
  `<p>Returns the numeric position of the first occurrence of needle in the haystack string. ` +
  `Unlike strripos, the offset is applied to the search from the start of the string. If ` +
  `needle is not found, the function returns false.</p>` +
  `</section>`;

const WP_CHROME =
  `<div class="topbar"><ul>` +
  `<li><a href="/si">Sign in</a></li><li><a href="/re">Register</a></li>` +
  `<li><a href="/pr">Pricing</a></li><li><a href="/bl">Blog</a></li>` +
  `<li><a href="/do">Docs</a></li><li><a href="/co">Company</a></li>` +
  `<li><a href="/ab">About</a></li><li><a href="/ca">Careers</a></li><li><a href="/ct">Contact</a></li>` +
  `</ul></div>`;
const WP_CONTENT =
  `<div class="entry-content wp-content"><h1>A practical guide to extraction</h1>` +
  `<p>This long-form article body lives inside a multi-class container whose class attribute ` +
  `carries more than one token. A whole-string class comparison would miss it; only ` +
  `whitespace-tokenized matching recognizes entry-content as a content signal.</p>` +
  `<p>The guide continues with substantial prose so the container holds the large majority ` +
  `of the page text and the feed is scoped to this article, not the preceding top-bar chrome.</p>` +
  `</div>`;

// A no-landmark page whose whole body IS the recognized container (>= 200 chars) — resolves
// jsRequired:false today and post-impl; used by the shell-gate guard C6b.
const REAL_CONTAINER =
  `<div id="content"><h1>Real container page</h1>` +
  `<p>Enough real prose content sits inside this recognized container to clear the content ` +
  `threshold and resolve the page as static HTML that does not require a JavaScript render, ` +
  `so the shell gate reports that usable content is present.</p>` +
  `</div>`;

// --- C1: cppreference-shape (no landmark, MediaWiki <div id="content">). ---

test("#165 C1 cppreference-shape: #content leads, top-bar chrome does not", () => {
  const head = headOf(extract(page(CPPR_CHROME + CPPR_CONTENT)).text);
  assert.doesNotMatch(head, /Search|Create account|Log in|Namespaces/, "top-bar chrome must not lead the text");
  assert.match(head, /std::sort/, "the std::sort article prose leads instead");
});

// --- C2: php.net-shape (no landmark, <section id="layout-content"> — pins the section scan). ---

test("#165 C2 php.net-shape: section#layout-content leads, navbar chrome does not", () => {
  const head = headOf(extract(page(PHP_CHROME + PHP_CONTENT)).text);
  assert.doesNotMatch(head, /Downloads|Documentation|Get Involved/, "navbar chrome must not lead the text");
  assert.match(head, /strpos/, "the strpos manual-entry prose leads instead");
});

// --- C3: multi-class container (<div class="entry-content wp-content"> — pins class-tokenization). ---

test("#165 C3 multi-class container: entry-content wp-content leads", () => {
  const head = headOf(extract(page(WP_CHROME + WP_CONTENT)).text);
  assert.doesNotMatch(head, /Sign in|Register|Pricing/, "top-bar chrome must not lead the text");
  assert.match(head, /practical guide/, "the article prose leads instead");
});

// --- C4: fail-safe — no recognized container -> whole chrome-stripped body, no loss (== today). ---

test("#165 C4 fail-safe: no recognized container -> whole body, no content lost", () => {
  const text = extract(page(
    `<div class="topbar"><a href="/h">Home</a> <a href="/a">About</a></div>` +
    `<div class="post"><h1>Bare div article</h1>` +
    `<p>This page has no allowlisted content container id or class. Its content sits in ` +
    `generic divs and must survive the no-container fallback entirely without loss.</p>` +
    `</div>`,
  )).text;
  assert.match(text, /Bare div article/, "real heading survives");
  assert.match(text, /no allowlisted content container/, "real body prose survives (no loss)");
});

// --- C5: fail-safe — below-floor minority #content rejected; real content survives (== today).
//     The #content fragment is >= 200 chars (clears the absolute axis) but a small MINORITY
//     of body text (fails the 0.7 fraction axis), so it is rejected and nothing is lost. ---

test("#165 C5 fail-safe: below-floor minority #content rejected, real content survives", () => {
  const text = extract(page(
    `<div id="content">` +
    `<p>A short navigational table-of-contents fragment that lives inside the allowlisted ` +
    `container but is only a minority of the page text overall, well below the selection ` +
    `fraction, so the heuristic must reject it and keep the whole body instead.</p>` +
    `</div>` +
    `<div class="realbody"><h1>The real article body that is the majority</h1>` +
    `<p>The genuine primary content lives outside the allowlisted container in a generic ` +
    `sibling div and forms the substantial majority of the total visible text, well above ` +
    `the selection threshold, so the heuristic rejects the minority container.</p>` +
    `<p>A second paragraph of the genuine majority content reinforcing that the real article ` +
    `body dominates the page text and the minority container is bypassed without any loss.</p>` +
    `</div>`,
  )).text;
  assert.match(text, /real article body that is the majority/, "majority heading survives");
  assert.match(text, /genuine primary content/, "majority body prose survives (no loss)");
});

// --- C6: shell-gate preserved (regression guard; green today). Container selection must NOT
//     flip the gate — a short shell still escalates, a real-text container does not. ---

test("#165 C6a shell-gate: short #content SPA shell still escalates (jsRequired)", () => {
  assert.equal(
    extract(page(`<div id="content">Loading</div>`)).shellGate.jsRequired,
    true,
    "a short SPA-shell container escalates to render",
  );
});

test("#165 C6b shell-gate: real-text container does not escalate", () => {
  const result = extract(page(REAL_CONTAINER));
  assert.equal(result.shellGate.jsRequired, false, "a real-text container resolves as static content");
  assert.match(result.text, /Real container page/, "the container prose is the visible text");
});

// --- C7: landmark precedence — <article> wins over a recognized #content (== today). ---

test("#165 C7 landmark precedence: <article> wins over a recognized #content container", () => {
  const result = extract(page(
    `<div id="content"><p>Container text that must NOT win because a landmark is present.</p></div>` +
    `<article><h1>Landmark article title</h1>` +
    `<p>The real article body lives inside a semantic article landmark. When both a landmark ` +
    `and a recognized container exist, the landmark wins and its content leads the feed.</p>` +
    `</article>`,
  ));
  assert.match(headOf(result.text, 80), /Landmark article title/, "the landmark article leads");
  assert.doesNotMatch(result.text, /must NOT win/, "the sibling container is not the selected scope");
});

// --- C8: footer-keep on the fallback — no container clears the floor -> <footer> stays (== today). ---

test("#165 C8 footer-keep: no container clears the floor -> footer content stays", () => {
  const text = extract(page(
    `<div class="post"><h1>A page with no recognized container</h1>` +
    `<p>The body content sits in generic markup with no allowlisted container id or class, ` +
    `so no container clears the floor and the whole-body fallback is used.</p>` +
    `</div>` +
    `<footer>Copyright 2024 Acme Documentation. All rights reserved. Licensed CC-BY-SA.</footer>`,
  )).text;
  assert.match(text, /Copyright 2024 Acme Documentation/, "footer content kept on the whole-body fallback");
});

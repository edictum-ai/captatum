# Spec: #165 — Main-content container selection for the no-landmark path (cppreference/php.net lead chrome)

- **Issue:** [#165](https://github.com/edictum-ai/captatum/issues/165) (the "(D)" deferred from `docs/specs/146-noisy-extraction.md`)
- **Tier:** T3 (content selection over untrusted HTML — the no-landmark path feeds an agent's trusted "content" feed; selecting the wrong scope is content-integrity / prompt-injection-adjacent, same class as #146)
- **Status:** v2 — READY (3-lens independent critique folded in; see `165-no-landmark-content-container.critique.md`). Scope: a curated main-content **container allowlist** + a two-axis length floor on the no-landmark path. A generic readability-style **density reorder** is the larger, riskier build and is deliberately deferred as a documented extension point — it is NOT needed to fix either named repro.
- **Scope-signoff note (mechanism deviation):** #165 is titled "density/boilerplate reorder"; v1 delivers an **allowlist**, not density. Three independent critics unanimously assessed allowlist-first as the right minimal v1 — it fixes both named repros (verified: cppr `#content` holds 96% of body text, php `#layout-content` holds 91%), and density without a DOM parser is the riskier larger build (defuddle was already evaluated + rejected, `contracts.md`). The generic density pass is re-scoped to a separate follow-up. Proceeding on that assessment + the house minimal-machinery rule; PR description states the deviation.
- **Spec trailer for downstream PRs:** `Spec: docs/specs/165-no-landmark-content-container.md`

## Verified grounding (real fetched HTML, captatum's own extractor, 2026-07-12)

Per the #146 lesson — *verify the issue premise against source before designing*:

- **Both named repros have ZERO semantic landmarks** (`<header>`/`<main>`/`<article>`). cppreference: 0 of all (366 `<div>`, 0 `<section>`). php.net: `<nav class="navbar">` (already stripped by #160) + `<aside>`, but no `<main>`/`<article>`/`<header>`. Both take the no-landmark path.
- **Both carry a well-known CMS content container** that delimits the article (verified tag types, not assumed):
  - **cppreference** (MediaWiki): `<div id="content">` holds **9212 of 9590 body chars (96%)**, leads *"std::sort From cppreference.com…"*. `#bodyContent`/`#mw-content-text` are nested `<div>`s inside `#content`. Lead chrome is `#mw-head` (128 chars, **linkRatio 0.60**) + `#footer` (248 chars, linkRatio 0.78).
  - **php.net**: **`<section id="layout-content">`** (a `<section>`, NOT a `<div>` — load-bearing) holds **34658 of 37940 body chars (91%, linkRatio 0.05 — almost pure prose)**, leads near the `strpos` manual entry. Dropped chrome: `.navbar` + the top "Downloads Documentation Get Involved" nav. (`.refentry` is inert on this page — 9%, below the floor; kept in the allowlist for other refentry-shaped pages. `.headsup` is an intermittent release banner, not always present.)
- **The link-density signal discriminates** chrome (0.60–0.78) from content (0.05–0.34) — so a density heuristic *would* work, but is not needed for the named class.

## Problem

`extractHtml` (`index.ts`) scopes visible text to a landmark when one exists, else to `stripChromeFromRaw(input.html)` — the whole `<body>` minus `<aside>`/`<nav>` (and inert/hidden). On a no-landmark CMS/reference page, the residual lead chrome is bare `<div>`/`<table>`/`<ul>` (MediaWiki `#mw-head`; php.net top nav) that no landmark and no `<aside>`/`<nav>` delimits → it survives into the head of the visible-text feed. The agent sees *"cppreference.com Search 🔍 Create account Log in Namespaces…"* before *"std::sort"*. Content-integrity: nav/sidebar chrome is the most likely place for a hostile page to plant instruction-shaped text ahead of the real content; dropping it from the head is a #146-class improvement.

## Design

### New file: `src/infrastructure/extract/content-container.ts`

`selectContentContainer(cleanedBody, revealedIds): string | null` — operates on the chrome-stripped body (the existing `stripChromeFromRaw` output). Returns the **inner HTML of the recognized main-content container**, or `null` (caller keeps the whole chrome-stripped body).

1. **Scan a fixed tag set {`<div>`, `<section>`}** via `findStartTags` (linear, REDOS-bounded; `html.ts`). `<main>`/`<article>` are absent by definition on this path (`selectMainContentHtml` returned null). `<table>`/`<ul>`/`<form>` (the bare chrome carriers) are NOT scanned — they are what we drop, not select. `findStartTags` is called with NO `limit` (the full same-tag open arrays are needed for depth-counting in step 3).
2. **Filter to allowlisted candidates.** For each start tag, `parseAttributes` (quote-aware, `html.ts`) yields `id` + `class`. A candidate matches if `allowlistIds.has(id.toLowerCase())` OR any whitespace-token of `class` is in `allowlistClasses` (split `class` on `/\s+/` — `parseAttributes` returns it as one string; a whole-string compare would miss multi-class containers like `entry-content wp-content`). `id` is a single token.
3. **Cap + pair spans.** Keep the first `MAX_CONTENT_CANDIDATES` (**16**, document order — a pathological-flood bound; real pages have 1–3 matches, and the real container follows the chrome near the top of `<body>`). For each, compute its element span **depth-aware** via the existing `findMatchingClose` (`main-content.ts`, **exported** for reuse), passing the **FULL same-tag open array** as `opens` (not the allowlisted subset — depth-counting needs every `<div>`/`<section>` open, or the container pairs with a premature inner close → truncated span → silent content loss).
4. **Prescore by raw length (O(1)), then score only the top-K.** Sort candidates by raw `.content.length` descending; take the top **K=3**. Run `extractVisibleText(content, revealedIds)` (thread `revealedIds` from the full page) on ONLY those 3. This bounds the expensive ~10-pass `extractVisibleText` to ≤3 calls regardless of candidate count. Pick the text-richest of the 3 that clears `CONTENT_CONTAINER_MIN_CHARS` (**200**).
5. **Two-axis floor (fail-safe against content loss).** Compute `bodyTextLen = extractVisibleText(cleanedBody, revealedIds).length` (1 call). Accept the winner **only if** `winnerTextLen ≥ CONTENT_CONTAINER_MIN_FRACTION (0.7) × bodyTextLen` AND `winnerTextLen ≥ CONTENT_CONTAINER_MIN_CHARS (200)`. The 0.7 fraction (not 0.5) clears both repros (0.96/0.91) with margin AND inherently rejects any page where the content is split across the container and a sibling (a 55%/45% split → 0.55 < 0.7 → whole body, no loss). **Below the floor → return null** (keep the whole chrome-stripped body, losing nothing).
6. Return `winner.content` (inner HTML, no wrapper — same shape as `selectMainContentHtml`).

**Cross-file invariant:** `CONTENT_CONTAINER_MIN_CHARS` (200) intentionally exceeds `hasContent`'s `textLength >= 80` short-circuit (`shell-gate.ts`), so a selected container always passes `hasContent` on merit with `landmarkFound=false` (the tag-check branch is never reached). Pinned with a code comment + assertion; do not lower MIN_CHARS below 80 without revisiting the shell-gate.

### REDOS bound (concrete; pinned by a non-frozen `assertLinear` test)

Cost on a 5MB body (the `EXTRACT_CHAR_BUDGET`): 1×`findStartTags` per tag (O(body)) + ≤16×`findMatchingClose` (O(body) each, batched opens — REDOS-6 from #160) + ≤3×`extractVisibleText` (~10 passes each) + 1×`extractVisibleText` (bodyTextLen). **No N×`extractVisibleText`** (the v1 defect — scoring every candidate with the 10-pass extractor was N×body×10). The cap (16) bounds the flood surface; the prescore (raw length) bounds `extractVisibleText` to 3+1 calls. The REDOS guard (test/dos-extraction.test.ts) floods NESTED allowlist-class opens (`<div class="prose">×N</div>×N`) and asserts a BOUNDED ABSOLUTE ceiling — NOT a LARGE/SMALL wall-clock ratio: `selectContentContainer` is multi-pass, so a ratio is too sensitive to scheduler contention under parallel CI/local load to be a stable linearity signal (empirically non-monotonic under contention). Phase-isolated, each of `findStartTags`, `findMatchingClose×cap`, and `extractVisibleText` is independently linear on this input; the ceiling catches a catastrophic N× regression (an unbounded impl is minutes at the test's scale).

### Integration — `src/infrastructure/extract/index.ts`

```ts
const landmark = html ? selectMainContentHtml(input.html, revealedIds) : null;
// cleanedBody is computed ONLY on the no-landmark path (preserve the existing short-circuit —
// do not pre-clean on every landmark-bearing page). footer-keep governs this whole-body fallback.
const cleanedBody = html && landmark === null ? stripChromeFromRaw(input.html, revealedIds) : null;
// No landmark → try a recognized main-content container (CMS/reference: cppreference, php.net)
// before the whole chrome-stripped body. A high-confidence container (≥0.7 of body text) is a
// STRONGER content signal than footer-keep, so it correctly overrides it; with no container the
// footer-keeping whole-body fallback stands. landmarkFound stays FALSE for a container (it is not
// an <article>/<main> landmark): the shell-gate evaluates the container text on merit, so an
// empty/short <div id="content"> SPA shell still escalates to render (#144).
const container = cleanedBody !== null ? selectContentContainer(cleanedBody, revealedIds) : null;
const scope = landmark ?? container ?? cleanedBody ?? input.html;
const text = html ? extractVisibleText(scope, revealedIds) : input.html;
// shellGate unchanged: contentHtml = scope, landmarkFound = landmark !== null
```

**Precedence:** landmark (`<article>`/`<main>`) > content container > chrome-stripped whole body. The container path fires ONLY when no landmark exists. `landmarkFound` (passed to `evaluateShellGate`) is `landmark !== null` — unchanged.

### Allowlist (curated, high-precision; conservative v1)

A `Set` of lowercased ids + a `Set` of lowercased class-tokens in `content-container.ts`. **v1 entries** (verified on repros + highest-precision conventional CMS/doc-site signals):

- **IDs:** `content`, `bodyContent`, `mw-content-text`, `mw-body-content`, `main-content`, `page-content`, `layout-content`, `primary-content`, `maincol`, `main-column`, `content-body`, `page-body`, `mainbody`, `documentation`, `docs-content`, `docs-body`, `article-body`, `dokuwiki__content`.
- **Classes (any whitespace-token match):** `entry-content`, `post-content`, `article-content`, `markdown-body`, `prose`, `td-content` (Sphinx/ReadTheDocs), `document`, `body-content`, `refentry` (php.net), `mw-body` (MediaWiki alt), `theme-doc-markdown` (Docusaurus).

An **allowlist for content selection, not a security gate** — the precision spirit of the house allowlist rule applies, and the two-axis floor makes the decision fail-safe (no/weak match → unchanged behavior). Widening is a documented extension (one entry per real page justifying it). **Excluded by design:** SPA app roots (`main`/`root`/`app`/`__next` — empty shells; `hasAppRoot` treats these as shell signals), layout (`wrapper`/`container`/`page`), chrome (`header`/`footer`/`nav`/`sidebar`). `[role="main"]` attribute selection is a v1.1 extension.

## Contract changes (contract-first — applied in this PR)

- **`docs/contracts.md`** (extraction paragraph, ~line 534): extend the no-landmark sentence to: *"If the no-landmark body carries a **recognized main-content container** (a curated, high-precision ID/class allowlist — MediaWiki `#content`/`#bodyContent`/`#mw-content-text`, `#main-content`, `#layout-content`, `.entry-content`, `.refentry`, `.td-content`, …), the visible-text scope is narrowed to it so a CMS/reference page (cppreference, php.net) leads with its article, not the top-bar/sidebar bare-`<div>` chrome. A container is accepted only under a two-axis length floor (a fraction of the page's visible text AND an absolute minimum), so a below-floor false-positive container never loses content; with no recognized container the chrome-stripped whole-body fallback stands. This is an allowlist (precision over coverage); a generic density reorder for pages with no conventional container is a documented extension point, not in this change (#165)."*
- **`docs/threat-model.md`** (~line 94, REDOS-5): the content-container selector is a linear `findStartTags` scan + ≤16 `findMatchingClose` + ≤4 `extractVisibleText` (raw-length prescore bounds the extractor calls), no new REDOS surface. Content-integrity: scoping to a recognized container drops top-bar/sidebar chrome (the most injection-shaped region) from the head of the trusted feed. **Residual (honest):** the selector is a heuristic a hostile page author can game — the floor bounds false-positive *size*, not false-positive *identity*; an above-floor wrong container can narrow the feed away from content held elsewhere. Acceptable because the threat model for reference/doc pages is legitimate-but-noisy authors (not third-party injection), and a hostile author can dominate the feed regardless. The existing `selectMainContentHtml` has the same N×`extractVisibleText` shape at tiny real counts (≤2 `<article>`/`<main>`); documented as a low-blast-radius residual, not patched here.

## Acceptance criteria (frozen suite — `test/acceptance/165/`, authored independently)

Authored by a **different harness than the coder**; merged (phase `165: false`, inactive) in its own PR (PR A) before implementation; activated (`165: true`) in the impl PR (PR B). **Effects-only** — assertions check the OUTPUT TEXT (chrome dropped, prose leads), never the internal selector chosen or the floor constants (those are impl-detail in non-frozen `test/*.test.ts`, per [[captatum-frozen-suite-contract-only]] — the #151 lesson). Fixtures use realistic selectors to construct the scenario; assertions call `extractHtml` and check `.text`.

1. **cppreference-shape (no landmark, MediaWiki `#content` div):** a no-landmark page whose top-bar chrome precedes `<div id="content">` holding the article → the chrome is NOT in the head of `.text`; the article H1/prose leads.
2. **php.net-shape (no landmark, `<section id="layout-content">`):** a no-landmark page whose navbar precedes `<section id="layout-content">` → navbar chrome dropped from the head; the manual-entry prose leads. (Pins the `<section>` scan — a div-only impl fails this.)
3. **Class-based multi-class container:** a no-landmark page whose content is in `<div class="entry-content wp-content">` → chrome dropped, prose leads. (Pins class-tokenization.)
4. **Fail-safe — no recognized container:** a no-landmark page whose content is in bare `<div>`s with no allowlisted id/class → `.text` is the whole chrome-stripped body (current behavior; no content lost).
5. **Fail-safe — below-floor minority container:** a no-landmark page with `<div id="content">` holding a SMALL MINORITY of the text while the real content is elsewhere → the container is rejected; the real content survives in `.text` (no loss).
6. **Shell-gate preserved:** a no-landmark SPA shell `<body><div id="content">Loading</div></body>` → `jsRequired: true` (escalates); a no-landmark page with a real-text container → `jsRequired: false`. (`landmarkFound` false on the container path.)
7. **Landmark precedence:** a page WITH `<article>` (or `<main>`) AND `<div id="content">` → the landmark wins; the container path does not fire.
8. **Footer-keep unchanged on the fallback:** when no container clears the floor, `<footer>` content stays in `.text` (the whole-body fallback's footer-keep rule stands).

**Verify bar (real-input, not fixtures alone):** `en.cppreference.com/w/cpp/algorithm/sort` + `www.php.net/manual/en/function.strpos.php` through the REAL cli (`node --no-warnings src/cli.ts <url> --output raw`) — confirm the lead chrome is gone and the article/manual prose leads. Each frozen fixture must FAIL with the fix reverted (the fail-safe cases #4/#5/#8 excepted by construction — they assert unchanged behavior).

## Implementation PR (PR B)

`test/extract.test.ts` + a new `test/content-container.test.ts` (selector unit cases: tag set {div,section}, class-tokenization, depth-aware span via full-opens, the 0.7/200 floor boundary, clear-no-loss on the 55/45 split, candidate cap), `test/dos-extraction.test.ts` (a bounded absolute-ceiling REDOS guard on nested allowlist-class opens — a wall-clock ratio is load-sensitive for this multi-pass function). The frozen `test/acceptance/165/` suite is separate, authored first (PR A). Impl flips `test/acceptance/phases.json` `"165": true`. Export `findMatchingClose` from `main-content.ts` for reuse.

## Deferred (recorded gaps, NOT in #165)

- **Generic density/link-ratio reorder** for no-landmark pages with NO conventional content container (bespoke layouts) — the readability-style heuristic the issue title names. Partition by top-level block children of the chrome-stripped body, score by prose-density vs link-density (the 0.05–0.34 vs 0.6–0.78 discriminator measured here), pick the densest, bounded + linear. Separate T3 follow-up issue if the allowlist leaves a residual noisy class.
- **`[role="main"]` attribute selection** + a broader allowlist (Docusaurus/Algolia/Mintlify class names, WordPress `.hentry`, Drupal `.node`) — widen only with a real page justifying each entry.

import { collectHiddenDisplayNoneClasses } from "./hidden-classes.ts";
import { revealedReactBoundaryIds, stripHiddenSubtrees } from "./hidden.ts";
import { extractBodyHtml, extractVisibleText, findCloseTag, findElements, findStartTags, findTagEnd, stripElement, stripHtmlComments } from "./html.ts";

/**
 * <main> overrides the best <article> only when it is substantially richer. Calibrated against
 * two real anchors: the MS-Learn hub <main>/<article> ≈ 4.7× (want <main> — the <article>s are
 * bare card tiles and <main> holds the hub intro+categories) and Anthropic/Mintlify ≈ 1.1× (want
 * <article> — the delta is footer/nav chrome). Chrome (aside/nav/footer) is stripped from the
 * tree before scoring, so a chrome-heavy <main> can't win on bulk alone. (#108)
 */
export const MAIN_OVERRIDE_FACTOR = 1.5;

/**
 * A LATER sibling <article> overrides the FIRST only when it is substantially richer AND the first
 * is skeleton-short. The first <article> is the page's primary content in document order (GitHub
 * README, blog post, docs section); a slightly-longer later sibling is usually a related/author
 * block and must NOT displace it (#108). But React streaming-SSR ships a SHORT loading-skeleton
 * <article> FIRST and the real streamed article as a far-richer later sibling (docs.anthropic.com:
 * skeleton ≈ 175 chars vs real ≈ 2901 chars, ~16×). The 5× ratio + the short-first guard let the
 * real article win for the React-skeleton case WITHOUT displacing a substantial primary on a React
 * page that merely has a `$RC` boundary elsewhere (e.g. in a header widget) — only a short first
 * article is treated as a skeleton (#118 codex P2).
 */
export const SIBLING_ARTICLE_OVERRIDE_FACTOR = 5;
/** A first <article> at or below this visible-text length is treated as a skeleton candidate
 *  (a loading placeholder, not primary content). Real article bodies are normally far larger. */
export const SKELETON_ARTICLE_MAX_CHARS = 1000;

/**
 * <aside>/<nav>/<footer> are chrome (sidebars, TOCs, mega-menus, page footers). They are stripped
 * from the pre-cleaned tree BEFORE scoring so (a) a chrome-heavy <main> is measured by its real
 * content, not its bulk, and (b) a "related posts" <article> nested in an <aside> can't win the
 * article pick by out-lengthing the real article. Verified no existing fixture places these tags
 * inside <main>, so the strip is fixture-safe. (#108)
 */
/** Depth-aware matching close for a chrome tag — pairs an outer open with its MATCHING close, not
 *  the inner's (handles nested same-tag chrome like `<nav>…<nav>…</nav>…</nav>`) (#160 codex r10). */
function findMatchingClose(lower: string, close: string, opens: readonly { start: number }[], openIdx: number, from: number): number {
  let depth = 1, search = from, nextOpenIdx = openIdx + 1;
  for (;;) {
    const nc = findCloseTag(lower, close, search);
    if (nc === -1) return -1;
    // Batch ALL opens before this close (avoids rescanning the same suffix per open — O(n²) on
    // deeply nested chrome like <nav>×n</nav>×n; #160 codex r15 REDOS-6).
    while (nextOpenIdx < opens.length && opens[nextOpenIdx].start < nc) { depth++; nextOpenIdx++; }
    if (--depth === 0) return nc;
    search = nc + close.length;
  }
}

/** Nesting-aware chrome strip: pairs each open with its matching close (depth-aware), and an
 *  unterminated chrome element (no close) is stripped to end (keep text-before). Replaces the
 *  non-nesting-aware stripElement for aside/nav/footer so nested menus don't leave leftover chrome. */
function stripChromeElement(html: string, tagName: string): string {
  const wanted = tagName.toLowerCase();
  const lower = html.toLowerCase();
  const opens = findStartTags(html, wanted);
  const close = `</${wanted}`;
  let out = "", cursor = 0;
  for (let i = 0; i < opens.length; i++) {
    const tag = opens[i];
    if (tag.start < cursor) continue;
    const closeStart = findMatchingClose(lower, close, opens, i, tag.end);
    if (closeStart === -1) return out + html.slice(cursor, tag.start); // unterminated: keep before, drop opener+remainder
    out += `${html.slice(cursor, tag.start)} `;
    cursor = findTagEnd(html, closeStart + 2);
  }
  return out + html.slice(cursor);
}

function stripChrome(html: string): string {
  return stripChromeElement(stripChromeElement(stripChromeElement(html, "aside"), "nav"), "footer");
}

/** Equivalent to the landmark-selection pre-clean for the no-landmark fallback. Order matters: a
 *  literal `<body>`/`<nav>` inside a `<title>`/`<script>`/`<style>`/comment is NOT real markup, so
 *  all inert RCDATA/code blocks (title + script/style/noscript/template + comments) are stripped
 *  FIRST, THEN the `<body>` is extracted, THEN hidden subtrees + site chrome — so a fake opener in
 *  any inert context can't be selected by extractBodyHtml or mis-paired by stripChrome (#160 codex).
 *  Hidden classes are collected from the FULL html before `<style>` is stripped. */
/** Context-aware inert-strip: removes comments + script/style/noscript/template/title in a SINGLE
 *  document-order pass. Processing in document order means a `<script>` inside a comment is never
 *  seen (the comment is stripped first when `<!--` comes first), and a `<!--` inside a script is
 *  never seen (the script is stripped first when `<script` comes first). Resolves the opposing-
 *  ordering problem that sequencing stripElement + stripHtmlComments can't (#160 codex r13). */
function stripInert(html: string): string {
  const lower = html.toLowerCase();
  const inertTags = ["script", "style", "noscript", "template", "title", "textarea"];
  // Collect all inert-block starts (comments + inert tags) in document order. For tags, store the
  // opener's `end` (after `>`) so findCloseTag searches from there — a `</script>` inside an
  // attribute like <script data-x="</script>"> must not be taken as the close (#160 codex r14a).
  const blocks: Array<{ start: number; openEnd?: number; tag?: string }> = [];
  let ci = 0;
  for (;;) {
    const at = html.indexOf("<!--", ci);
    if (at === -1) break;
    blocks.push({ start: at });
    ci = at + 4;
  }
  for (const tag of inertTags) for (const open of findStartTags(html, tag)) blocks.push({ start: open.start, openEnd: open.end, tag });
  blocks.sort((a, b) => a.start - b.start);
  // Process in order, skipping blocks inside already-stripped blocks. A space separator is inserted
  // (matching stripElement/stripHtmlComments) so `six<script>...</script>seven` → `six seven`, not
  // `sixseven` (which would drop the word count + corrupt the text) (#160 codex r14b).
  let out = "", cursor = 0;
  for (const b of blocks) {
    if (b.start < cursor) continue;
    out += `${html.slice(cursor, b.start)} `;
    if (b.tag === undefined) {
      const end = html.indexOf("-->", b.start + 4);
      cursor = end === -1 ? html.length : end + 3;
    } else {
      const close = findCloseTag(lower, `</${b.tag}`, b.openEnd!);
      cursor = close === -1 ? html.length : findTagEnd(html, close + 2 + b.tag.length);
    }
  }
  return out + html.slice(cursor);
}

export function stripChromeFromRaw(html: string, revealedIds: Set<string>): string {
  const hiddenClasses = collectHiddenDisplayNoneClasses(html);
  const inert = stripInert(html);
  const body = extractBodyHtml(inert) ?? inert;
  // Strip aside/nav ONLY (not <footer>) — a static page may carry its real content in a <footer>
  // (not site chrome in that context); stripping it loses the content (named-entities fixture
  // regression). The #144 repro (Jira REST v3) was nav/aside sidebar/TOC chrome, not footer.
  // The landmark path (selectMainContentHtml) still strips footer for scoring.
  const cleaned = stripHiddenSubtrees(body, hiddenClasses, revealedIds);
  return stripChromeElement(stripChromeElement(cleaned, "aside"), "nav");
}

/**
 * Selects the page's main-content HTML so `extractVisibleText` doesn't flatten site chrome
 * (nav / header / footer) ahead of the real body. Considers the FIRST <article> and the richest
 * <main>, returning whichever carries more visible text — with <main> winning only when it is
 * substantially richer (MAIN_OVERRIDE_FACTOR), because <main> often wraps the <article> plus
 * chrome that the tighter <article> scope excludes.
 *
 * Why the FIRST <article> is the default: document order makes the first <article> the page's
 * primary one (GitHub README, blog post, docs section). The card-grid hub case the old "return
 * the first <article> blindly" mishandled is rescued by the <main> override — a hub's <main>
 * holds the real intro+categories and is far larger than any tile, so <main> wins. A longer LATER
 * sibling <article> is usually a related/author block inside an <aside>, which stripChrome has
 * already removed from the candidate pool. The ONE exception is React streaming-SSR, which ships
 * a short loading-skeleton <article> first and the real streamed article as a substantially
 * richer later sibling — SIBLING_ARTICLE_OVERRIDE_FACTOR lets that real article win (#118).
 *
 * The page is pre-cleaned EXACTLY as `extractVisibleText` does before searching (hidden classes
 * collected from the full page, then script/style/noscript/template + comments + hidden subtrees
 * stripped), then chrome tags are dropped. This guarantees a literal `<article>` inside a
 * `<script>`/`<template>`/a comment / a hidden boundary (React streaming's `<div hidden>`) or a
 * chrome `<aside>`/`<nav>`/`<footer>` is never picked (#97 review). The scoped output feeds
 * evaluateShellGate (index.ts), so the selection changes render escalation: scoping to a short
 * skeleton makes the gate MORE likely to trip (correct — the page needs rendering), never less. (#93)
 */
export function selectMainContentHtml(html: string, revealedIds: Set<string> = revealedReactBoundaryIds(html)): string | null {
  // Fast path: no <article> AND no <main> → nothing to select. Skips the full pre-clean on the
  // common no-main-content page and — critically — on pathological inputs (the REDOS-5 <script>
  // flood), so cleaning runs once (in extractVisibleText) instead of twice and extractHtml stays
  // linear. Tests the RAW html (cheaper than re-testing `clean`; a substring inside a script /
  // comment just skips the short-circuit, never a false positive).
  if (!/<article/i.test(html) && !/<main/i.test(html)) return null;
  const hiddenClasses = collectHiddenDisplayNoneClasses(html);
  // revealedIds comes from the caller (the full page) so a scoped fragment's missing $RC call
  // does not under-detect streaming. A React `<div hidden id="S:N">` boundary completed by a
  // `$RC` is real server-streamed content the browser reveals, so the article inside one IS a
  // candidate (a genuinely `display:none`-hidden article is still excluded — #97 safety).
  const clean = stripChrome(stripHiddenSubtrees(stripInert(html), hiddenClasses, revealedIds));

  // Score every <article> by visible-text length. The FIRST is the page's primary (document
  // order), but a SUBSTANTIALLY richer sibling overrides it — a React loading skeleton is a short
  // placeholder shipped first; the real streamed article is a far larger later sibling. Scoring
  // threads revealedIds so a boundary-bearing fragment is measured with its streamed content.
  const articles = findElements(clean, "article").map<{ content: string; len: number }>((el) => ({
    content: el.content,
    len: extractVisibleText(el.content, revealedIds).length,
  }));
  const firstArticle = articles[0];
  const richestArticle = articles.reduce<{ content: string; len: number } | undefined>(
    (best, el) => !best || el.len > best.len ? el : best,
    undefined,
  );
  const longestMain = findElements(clean, "main").reduce<{ content: string; len: number } | undefined>(
    (best, el) => {
      const len = extractVisibleText(el.content, revealedIds).length;
      return !best || len > best.len ? { content: el.content, len } : best;
    },
    undefined,
  );
  // First <article> wins by default. A substantially richer sibling overrides it ONLY on a React
  // streaming page (revealedIds non-empty) WHEN the first article is skeleton-short — the React
  // loading-skeleton pattern (short placeholder first, real streamed article as a richer sibling).
  // The short-first guard prevents displacing a substantial primary on a React page that merely
  // has a $RC boundary elsewhere (a header/widget) (#118 codex P2).
  const firstIsSkeleton = !!firstArticle && firstArticle.len <= SKELETON_ARTICLE_MAX_CHARS;
  const selectedArticle = revealedIds.size > 0 && firstIsSkeleton && richestArticle && firstArticle && richestArticle.len >= firstArticle.len * SIBLING_ARTICLE_OVERRIDE_FACTOR
    ? richestArticle
    : firstArticle;
  const articleLen = selectedArticle?.len ?? 0;
  const mainLen = longestMain?.len ?? 0;

  if (selectedArticle && longestMain) {
    // <main> wins only when substantially richer (a tile <article> vs real content in <main>);
    // otherwise the <article>'s tighter scope avoids footer/nav/aside chrome.
    return mainLen >= articleLen * MAIN_OVERRIDE_FACTOR ? longestMain.content : selectedArticle.content;
  }
  return selectedArticle?.content ?? longestMain?.content ?? null;
}

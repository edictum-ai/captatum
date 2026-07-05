import { collectHiddenDisplayNoneClasses } from "./hidden-classes.ts";
import { revealedReactBoundaryIds, stripHiddenSubtrees } from "./hidden.ts";
import { extractVisibleText, findElements, stripElement, stripHtmlComments } from "./html.ts";

/**
 * <main> overrides the best <article> only when it is substantially richer. Calibrated against
 * two real anchors: the MS-Learn hub <main>/<article> ≈ 4.7× (want <main> — the <article>s are
 * bare card tiles and <main> holds the hub intro+categories) and Anthropic/Mintlify ≈ 1.1× (want
 * <article> — the delta is footer/nav chrome). Chrome (aside/nav/footer) is stripped from the
 * tree before scoring, so a chrome-heavy <main> can't win on bulk alone. (#108)
 */
export const MAIN_OVERRIDE_FACTOR = 1.5;

/**
 * A LATER sibling <article> overrides the FIRST only when it is substantially richer. The first
 * <article> is the page's primary content in document order (GitHub README, blog post, docs
 * section); a slightly-longer later sibling is usually a related/author block and must NOT
 * displace it (#108). But React streaming-SSR ships a short loading-skeleton <article> FIRST
 * and the real streamed article as a later sibling (e.g. docs.anthropic.com: skeleton ≈ 175
 * chars vs real ≈ 2901 chars, ~16×). The 5× threshold lets the real article win for the React
 * skeleton case while preserving the #108 author-bio tie-break (a ~2.4× sibling stays secondary).
 */
export const SIBLING_ARTICLE_OVERRIDE_FACTOR = 5;

/**
 * <aside>/<nav>/<footer> are chrome (sidebars, TOCs, mega-menus, page footers). They are stripped
 * from the pre-cleaned tree BEFORE scoring so (a) a chrome-heavy <main> is measured by its real
 * content, not its bulk, and (b) a "related posts" <article> nested in an <aside> can't win the
 * article pick by out-lengthing the real article. Verified no existing fixture places these tags
 * inside <main>, so the strip is fixture-safe. (#108)
 */
function stripChrome(html: string): string {
  return stripElement(stripElement(stripElement(html, "aside"), "nav"), "footer");
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
  const withoutCode = ["script", "style", "noscript", "template"]
    .reduce((value, tag) => stripElement(value, tag), html);
  const clean = stripChrome(stripHtmlComments(stripHiddenSubtrees(withoutCode, hiddenClasses, revealedIds)));

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
  // streaming page (revealedIds non-empty), where a short loading-skeleton <article> ships first
  // and the real streamed article is a far-richer later sibling. Gated to React so a non-React
  // page's first-article tie-break (#108) is never displaced by a longer sibling.
  const selectedArticle = revealedIds.size > 0 && richestArticle && firstArticle && richestArticle.len >= firstArticle.len * SIBLING_ARTICLE_OVERRIDE_FACTOR
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

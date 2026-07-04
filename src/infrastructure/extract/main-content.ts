import { findElements } from "./html.ts";

/**
 * Selects the page's main-content HTML so `extractVisibleText` doesn't flatten site chrome
 * (nav / header / footer) ahead of the real body. Targets the first `<article>` — the semantic
 * "self-contained content" element, which on repo/readme pages (GitHub's `<article
 * class="markdown-body entry-content">`) and most blog/docs pages holds the actual content.
 *
 * `<article>` is chosen over `<div id="readme">` / `<div class="markdown-body">` deliberately:
 * divs nest, so a first-close match (findElements / findCloseTag) would cut at the innermost
 * child's `</div>` — the balanced depth-counting extractor that case needs is the hard #54
 * Half B problem. Articles rarely nest, so first-close is correct here. Returns null when there
 * is no `<article>`, so the caller falls back to the full body (today's behavior) — no regression
 * for pages that use `<main>`/`<div>` only. (#93)
 */
export function selectMainContentHtml(html: string): string | null {
  const article = findElements(html, "article")[0];
  return article ? article.content : null;
}

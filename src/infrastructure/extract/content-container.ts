import type { AttributeMap } from "./html.ts";
import { extractVisibleText, findStartTags } from "./html.ts";
import { findMatchingClose } from "./main-content.ts";

/**
 * No-landmark main-content container selection (#165). On a page with no `<article>`/`<main>`
 * landmark (cppreference, php.net, MediaWiki/Sphinx/ReadTheDocs), the no-landmark fallback
 * feeds the whole chrome-stripped body — whose lead chrome sits in bare `<div>`/`<ul>` no
 * `<aside>`/`<nav>` delimits, so it leads the agent's text feed ahead of the prose. CMS/doc-site
 * generators put the real article in a CONVENTIONALLY-NAMED container; this recognizes it (a
 * curated ID/class allowlist) and scopes to it so the prose leads. A two-axis length floor makes
 * the decision fail-safe: a below-floor false-positive never loses content. A generic readability
 * density reorder is the documented extension point, not this change (docs/specs/165-*).
 *
 * Pure + linear (REDOS-bounded; see docs/threat-model.md). Operates on the chrome-stripped body
 * (`stripChromeFromRaw` output). Returns the recognized container's INNER html, or null (the
 * caller keeps the whole chrome-stripped body, losing nothing). Not a security gate; the floor
 * bounds false-positive SIZE, not IDENTITY — a hostile author can still size an allowlisted
 * container above the floor (acceptable: reference/doc pages are legitimate-but-noisy authors).
 */
export function selectContentContainer(cleanedBody: string, revealedIds: Set<string>): string | null {
  const lower = cleanedBody.toLowerCase();
  const bodyTextLen = extractVisibleText(cleanedBody, revealedIds).length;
  if (bodyTextLen === 0) return null;

  // Gather allowlisted <div>/<section> candidates. findMatchingClose needs the FULL same-tag
  // open array for depth-counting (a subset would pair an open with a premature inner close →
  // a truncated span → silent content loss). The cap is a pathological-flood bound (real pages
  // have 1–3 matches; the content container follows the chrome near the top of <body>).
  const candidates: Array<{ content: string; rawLen: number }> = [];
  const scan = (tagName: string, close: string): void => {
    const opens = findStartTags(cleanedBody, tagName);
    let added = 0; // PER-TAG cap: a <div> allowlist flood must not eat the cap before the <section>
    // scan runs (e.g. 16 allowlisted divs starving <section id="layout-content">). Each tag gets
    // up to MAX_CONTENT_CANDIDATES; the shared `candidates` pool is then prescored across both.
    for (let i = 0; i < opens.length; i++) {
      if (added >= MAX_CONTENT_CANDIDATES) break;
      if (!isContentContainer(opens[i].attrs)) continue;
      const closeStart = findMatchingClose(lower, close, opens, i, opens[i].end);
      if (closeStart === -1) {
        // unterminated → content runs to end (browser auto-close extends a flow element to </body>)
        candidates.push({ content: cleanedBody.slice(opens[i].end), rawLen: cleanedBody.length - opens[i].end });
      } else {
        candidates.push({ content: cleanedBody.slice(opens[i].end, closeStart), rawLen: closeStart - opens[i].end });
      }
      added++;
    }
  };
  scan("div", "</div");
  scan("section", "</section");
  if (candidates.length === 0) return null;

  // Prescore by raw content length (O(1)); run the ~10-pass extractVisibleText on ONLY the top-K
  // (the v1-defect fix — scoring every candidate with the extractor was N×body×10 on nested 5MB).
  candidates.sort((a, b) => b.rawLen - a.rawLen);
  let best: { content: string; textLen: number } | null = null;
  for (const c of candidates.slice(0, TOP_K)) {
    const textLen = extractVisibleText(c.content, revealedIds).length;
    if (textLen >= CONTENT_CONTAINER_MIN_CHARS && (best === null || textLen > best.textLen)) {
      best = { content: c.content, textLen };
    }
  }
  if (best === null) return null;
  // Two-axis floor: the winner must be a clear majority of the body (≥ MIN_FRACTION) AND clear
  // the absolute floor. The fraction rejects any page where the content is split across the
  // container and a sibling (a 55/45 split → 0.55 < 0.7 → whole body, no loss). MIN_CHARS (200)
  // intentionally exceeds hasContent's 80 threshold (shell-gate.ts) so a selected container
  // always passes hasContent on merit with landmarkFound=false — do not lower it below 80.
  return best.textLen >= CONTENT_CONTAINER_MIN_FRACTION * bodyTextLen ? best.content : null;
}

/** A start tag is a content-container candidate iff its id (single token) or any whitespace
 *  token of its class matches the allowlist. parseAttributes returns class as one string, so a
 *  whole-string compare would miss multi-class containers (`entry-content wp-content`). */
function isContentContainer(attrs: AttributeMap): boolean {
  const id = (attrs.id ?? "").toLowerCase();
  if (id && CONTENT_CONTAINER_IDS.has(id)) return true;
  const cls = attrs.class ?? "";
  if (cls) {
    for (const token of cls.split(/\s+/)) {
      if (token && CONTENT_CONTAINER_CLASSES.has(token.toLowerCase())) return true;
    }
  }
  return false;
}

/** Accepted only when the container holds ≥ this fraction of the body's visible text. 0.7 clears
 *  both repros (cppr 0.96, php 0.91) with margin AND rejects any split-content page. (#165) */
export const CONTENT_CONTAINER_MIN_FRACTION = 0.7;
/** Absolute floor: a selected container's visible text must be ≥ this many chars. Exceeds
 *  hasContent's 80-char threshold so a selected container passes the shell gate on merit. */
export const CONTENT_CONTAINER_MIN_CHARS = 200;
/** Pathological-flood bound on candidates scored (per tag). Real pages have 1–3 matches; 16
 *  covers any legitimate case with margin while bounding the per-candidate findMatchingClose cost. */
const MAX_CONTENT_CANDIDATES = 16;
/** The ~10-pass extractVisibleText runs on only the top-K candidates by raw length. */
const TOP_K = 3;

/** Curated, high-precision main-content container IDs (CMS/doc-site conventions). Widening is a
 *  documented extension — one entry per real page justifying it. Excludes SPA app roots
 *  (`main`/`root`/`app`/`__next` — empty shells) and chrome (`header`/`footer`/`nav`/`sidebar`). */
const CONTENT_CONTAINER_IDS = new Set([
  "content", "bodycontent", "mw-content-text", "mw-body-content", "main-content",
  "page-content", "layout-content", "primary-content", "maincol", "main-column",
  "content-body", "page-body", "mainbody", "documentation", "docs-content",
  "docs-body", "article-body", "dokuwiki__content",
]);
/** Curated main-content container classes (any whitespace-token match). `prose` is deliberately
 *  EXCLUDED — it is Tailwind Typography's generic styled-text utility (comments, sidebars, footer
 *  legal text), not a content-container convention; a large `.prose` block would clear the floor
 *  and displace the real article (content-loss). Re-add only behind a density signal. */
const CONTENT_CONTAINER_CLASSES = new Set([
  "entry-content", "post-content", "article-content", "markdown-body",
  "td-content", "document", "body-content", "refentry", "mw-body", "theme-doc-markdown",
]);

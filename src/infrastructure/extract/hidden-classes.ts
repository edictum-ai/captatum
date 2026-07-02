import { findStartTags, stripElement, stripHtmlComments } from "./html.ts";

// Collects class names that a `<style>` block declares `display:none`, so the
// hidden-subtree stripper (hidden.ts) can suppress elements hidden via a class
// (the third hiding vector after inline `style` and the `hidden` attribute).
// Without this, config blobs in `<div class="config-hidden">` leak into the
// extracted visible text (the class variant of the vscdn/Netflix bug).
//
// Only SINGLE-class selectors (`.foo`, or a comma list of them) are honored, so a
// combinator selector like `.parent .child { display:none }` does NOT mark `.parent`
// hidden (it is only conditionally hidden inside `.parent`, which we can't model).
// The scan is brace/index-based (no backtracking regexes); input is char-capped
// upstream.

/** Class names that an active (on-screen) `<style>` block declares `display:none`,
 *  respecting source order ACROSS blocks: a later block's `.h{display:block}`
 *  overrides an earlier `.h{display:none}` (browser applies the last declaration). */
export function collectHiddenDisplayNoneClasses(html: string): Set<string> {
  const lastIsHidden = new Map<string, boolean>();
  // Strip comments + script/noscript/template BEFORE scanning, so a `<style>`
  // string that lives inside a script/template/comment (inert — the browser never
  // applies it) can't fake a hidden class and strip real visible content.
  const live = ["script", "noscript", "template"].reduce(
    (value, tag) => stripElement(value, tag),
    stripHtmlComments(html),
  );
  const lower = live.toLowerCase();
  for (const tag of findStartTags(live, "style")) {
    if (!styleAppliesToScreen(tag.attrs.media, tag.attrs.type)) continue;
    const closeStart = findStyleClose(lower, tag.end);
    if (closeStart === -1) continue;
    collectDisplayNoneClasses(live.slice(tag.end, closeStart), lastIsHidden);
  }
  const classes = new Set<string>();
  for (const [cls, hidden] of lastIsHidden) if (hidden) classes.add(cls);
  return classes;
}

/** Whether a `<style>` block's rules apply to on-screen rendering. Non-CSS types
 *  (e.g. text/plain) and non-screen media are inert on screen and must not hide
 *  content. Media handling: empty/all/screen apply; "not screen" excludes screen;
 *  a non-screen medium (print/speech/tv/tty) without screen/all is inert; a bare
 *  query with no media-type keyword ("(min-width:…)") defaults to all and applies. */
function styleAppliesToScreen(media: string | undefined, type: string | undefined): boolean {
  const t = (type ?? "").trim().toLowerCase();
  if (t !== "" && t !== "text/css") return false;
  const m = (media ?? "").trim().toLowerCase();
  if (!m || m === "all" || m === "screen") return true;
  if (/\bnot\s+screen\b/.test(m)) return false;
  if (/\bnot\s+(?:print|speech|tv|tty)\b/.test(m)) return true; // "not print" includes screen
  if (/\b(?:screen|all)\b/.test(m)) return true;
  if (/\b(?:print|speech|tv|tty)\b/.test(m)) return false; // a non-screen medium, no screen/all present
  return true; // no media-type keyword → bare query → implicit "all"
}

/** Index of the next `</style` at a tag boundary (`>` `/` whitespace) at/after
 *  `from`. Iterative (not recursive) so a flood of boundary-miss strings like
 *  `</stylex` can't overflow the stack within the 1 MB extraction cap. */
function findStyleClose(lower: string, from: number): number {
  let search = from;
  for (;;) {
    const at = lower.indexOf("</style", search);
    if (at === -1) return -1;
    const next = lower[at + 7];
    if (next === undefined || next === ">" || next === "/" || next === " " || next === "\t" || next === "\n" || next === "\r") return at;
    search = at + 1;
  }
}

function collectDisplayNoneClasses(css: string, lastIsHidden: Map<string, boolean>): void {
  // Record the LAST display value per class into the shared map (later rules
  // override earlier). Known gap: rules nested inside @media/@supports at-rules
  // are not descended (flat brace scan) — under-hides (safe direction).
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf("{", cursor);
    if (open === -1) break;
    const close = css.indexOf("}", open);
    if (close === -1) break;
    const hidden = declarationIsDisplayNone(css.slice(open + 1, close));
    for (const part of css.slice(cursor, open).split(",")) {
      const simple = /^\.([A-Za-z0-9_-]+)$/.exec(part.trim());
      if (simple) lastIsHidden.set(simple[1], hidden);
    }
    cursor = close + 1;
  }
}

function declarationIsDisplayNone(block: string): boolean {
  for (const declaration of block.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    if (declaration.slice(0, colon).trim().toLowerCase() !== "display") continue;
    const value = declaration.slice(colon + 1).trim().toLowerCase().replace(/\s*!\s*important\s*$/, "");
    if (value === "none") return true;
  }
  return false;
}

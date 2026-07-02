import { findStartTags, findTagEnd, stripElement, stripHtmlTags } from "./html.ts";

// SVG charts carry real data inside `<text>` elements ("Q1: $1.2M"). The visible-
// text pipeline strips `<svg>` wholesale (like script/style), which drops those
// labels along with the vector geometry. This module inlines each `<svg>` block's
// `<text>` children into the surrounding text BEFORE the svg is stripped, so chart
// data survives while paths/attributes/`<title>` (not data) are discarded.
//
// The svg subtree is replaced by a space + the concatenated `<text>` content; an
// svg with no `<text>` becomes a single space (the svg is removed either way). The
// scan is linear and start-tag/close-tag based (no backtracking regexes).

/** Replace each `<svg>…</svg>` with the inner text of its `<text>` children. */
export function inlineSvgText(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let cursor = 0;
  for (const tag of findStartTags(html, "svg")) {
    if (tag.start < cursor) continue;
    const closeStart = findCloseTag(lower, "</svg", tag.end);
    if (closeStart === -1) {
      // Unclosed svg — leave the remainder; its tags strip later.
      return out + html.slice(cursor);
    }
    const inner = html.slice(tag.end, closeStart);
    const text = collectSvgTextElements(inner);
    out += html.slice(cursor, tag.start) + (text ? ` ${text} ` : " ");
    cursor = findTagEnd(html, closeStart + 2);
  }
  return out + html.slice(cursor);
}

/** Concatenate the trimmed inner text of every rendered `<text>` element in an svg
 *  subtree. Skips labels hidden via SVG presentation attributes (`display="none"` /
 *  `visibility="hidden"`) and text inside non-rendering containers (`<defs>` /
 *  `<symbol>` — definitions/templates the browser never paints). */
function collectSvgTextElements(svgInner: string): string {
  // Drop non-rendering containers wholesale so their `<text>` labels don't leak.
  const painted = stripElement(stripElement(svgInner, "defs"), "symbol");
  const lower = painted.toLowerCase();
  let out = "";
  for (const tag of findStartTags(painted, "text")) {
    // A self-closing `<text/>` carries no content; skip it so its indexOf("</text")
    // doesn't latch onto a sibling's close tag and duplicate the sibling's label.
    if (tag.raw.endsWith("/>")) continue;
    const display = (tag.attrs.display ?? "").toLowerCase();
    const visibility = (tag.attrs.visibility ?? "").toLowerCase();
    if (display === "none" || visibility === "hidden") continue;
    const closeStart = lower.indexOf("</text", tag.end);
    const raw = closeStart === -1 ? painted.slice(tag.end) : painted.slice(tag.end, closeStart);
    // `<tspan>` and similar nested tags inside `<text>` are stripped to bare text.
    const cleaned = stripHtmlTags(raw).trim();
    if (cleaned) out += ` ${cleaned}`;
  }
  return out.trim();
}

/** Find `</name` at a tag boundary (`>` `/` whitespace) at/after `from`. Mirrors
 *  html.ts's private finder so svg closing tags are matched the same way. */
function findCloseTag(lower: string, closeOpen: string, from: number): number {
  let search = from;
  for (;;) {
    const at = lower.indexOf(closeOpen, search);
    if (at === -1) return -1;
    const next = lower[at + closeOpen.length];
    if (next === undefined || next === ">" || next === "/" || next === " " || next === "\t" || next === "\n" || next === "\r") {
      return at;
    }
    search = at + 1;
  }
}

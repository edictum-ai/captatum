import { collapseWhitespace, decodeHtmlEntities, normalizeFragmentedNumbers } from "./entities.ts";
import { collectHiddenDisplayNoneClasses } from "./hidden-classes.ts";
import { revealedReactBoundaryIds, stripHiddenSubtrees } from "./hidden.ts";
import { inlineSvgText } from "./svg-text.ts";

export interface HtmlTag {
  name: string;
  attrs: AttributeMap;
  start: number;
  end: number;
  raw: string;
}

export interface AttributeMap {
  [key: string]: string;
}

export interface HtmlElement {
  tag: HtmlTag;
  content: string;
  end: number;
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function findStartTags(html: string, tagName: string, limit = Number.POSITIVE_INFINITY): HtmlTag[] {
  const wanted = tagName.toLowerCase();
  const tags: HtmlTag[] = [];
  let offset = 0;

  while (offset < html.length) {
    const start = html.indexOf("<", offset);
    if (start === -1) break;
    const tag = readStartTag(html, start);
    offset = Math.max(start + 1, tag?.end ?? start + 1);
    if (tag?.name === wanted) {
      tags.push(tag);
      if (tags.length >= limit) break;
    }
  }

  return tags;
}

export function findElements(html: string, tagName: string): HtmlElement[] {
  // REDOS-5: linear — one advancing cursor finds each close via boundary-checked
  // findCloseTag; on the first missing close, no later opener has one either, so stop.
  const lower = html.toLowerCase();
  const wanted = tagName.toLowerCase();
  const close = `</${wanted}`;
  const elements: HtmlElement[] = [];
  let cursor = 0;
  for (const tag of findStartTags(html, wanted)) {
    if (tag.start < cursor) continue; // a tag inside an already-consumed element swallows a sibling (PR #86)
    if (tag.end > cursor) cursor = tag.end;
    const closeStart = findCloseTag(lower, close, cursor);
    if (closeStart === -1) {
      elements.push({ tag, content: html.slice(tag.end), end: html.length });
      return elements;
    }
    const closeEnd = findTagEnd(html, closeStart + 2);
    elements.push({ tag, content: html.slice(tag.end, closeStart), end: closeEnd });
    cursor = closeEnd;
  }
  return elements;
}

export function extractVisibleText(html: string, revealedIds: Set<string> = revealedReactBoundaryIds(html)): string {
  const hiddenClasses = collectHiddenDisplayNoneClasses(html);
  // revealedIds is caller-supplied (from the full page): a scoped fragment loses the $RC call (#118 codex P1).
  const body = extractBodyHtml(html) ?? stripElement(html, "head");
  // `svg` is NOT stripped here — inlineSvgText (next) preserves its `<text>` chart
  // data before the wrapper is removed. stripHiddenSubtrees also drops class-based
  // display:none from `<style>` blocks (the hiddenClasses set).
  const withoutCode = ["script", "style", "noscript", "template"]
    .reduce((value, tag) => stripElement(value, tag), body);
  // Linear O(n) scanners (REDOS-1/2/3): old backtracking regexes were quadratic on
  // `<!--`/bare-`<`/`<script>` floods. stripHiddenSubtrees runs BEFORE inlineSvgText
  // so a hidden svg (`<svg hidden>`/display:none/hidden class) is dropped together
  // with its `<text>` instead of leaking the labels into visible text.
  const text = stripHtmlTags(stripHtmlComments(inlineSvgText(stripHiddenSubtrees(withoutCode, hiddenClasses, revealedIds))));
  return normalizeFragmentedNumbers(collapseWhitespace(decodeHtmlEntities(text)));
}

/**
 * Remove `<!-- ... -->` spans linearly, replacing each with a space (matching the
 * old `<!--[\s\S]*?-->` → " "). An unterminated `<!--` (no `-->`) keeps the text
 * before it and stops — the remainder is malformed and dropping it avoids feeding
 * a bare-`<` flood to stripHtmlTags.
 */
export function stripHtmlComments(html: string): string {
  let out = "";
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<!--", cursor);
    if (start === -1) { out += html.slice(cursor); break; }
    const end = html.indexOf("-->", start + 4);
    if (end === -1) { out += `${html.slice(cursor, start)} `; break; }
    out += `${html.slice(cursor, start)} `;
    cursor = end + 3;
  }
  return out;
}

/** Remove `<...>` tag spans linearly → " " (old `<[^>]*>` was REDOS-2). A `<` with no
 *  following `>` ends the scan: the rest is literal text, appended once. */
export function stripHtmlTags(html: string): string {
  let out = "";
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start === -1) { out += html.slice(cursor); break; }
    const end = html.indexOf(">", start + 1);
    if (end === -1) { out += html.slice(cursor); break; }
    out += `${html.slice(cursor, start)} `;
    cursor = end + 1;
  }
  return out;
}

export function firstAttr(
  html: string,
  tagName: string,
  predicate: (attrs: AttributeMap) => boolean,
  attrName: string,
): string | undefined {
  for (const tag of findStartTags(html, tagName)) {
    if (predicate(tag.attrs)) return tag.attrs[attrName.toLowerCase()];
  }
  return undefined;
}

export function readStartTag(html: string, start: number): HtmlTag | null {
  const next = html[start + 1];
  if (!next || next === "/" || next === "!" || next === "?") return null;

  let cursor = start + 1;
  while (/\s/.test(html[cursor] ?? "")) cursor += 1;
  const nameStart = cursor;
  while (cursor < html.length && /[^\s/>]/.test(html[cursor] ?? "")) cursor += 1;
  if (cursor === nameStart) return null;

  const name = html.slice(nameStart, cursor).toLowerCase();
  const close = findTagEnd(html, cursor);
  const raw = html.slice(start, close);
  return { name, attrs: parseAttributes(raw), start, end: close, raw };
}

export function findTagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let index = from; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index + 1;
    }
  }
  return html.length;
}

function parseAttributes(rawTag: string): AttributeMap {
  const attrs = {} as AttributeMap;
  let cursor = rawTag.indexOf("<") + 1;
  while (cursor < rawTag.length && /[^\s/>]/.test(rawTag[cursor] ?? "")) cursor += 1;

  while (cursor < rawTag.length) {
    while (cursor < rawTag.length && /[\s/>]/.test(rawTag[cursor] ?? "")) cursor += 1;
    const nameStart = cursor;
    while (cursor < rawTag.length && /[^\s=/>]/.test(rawTag[cursor] ?? "")) cursor += 1;
    if (cursor === nameStart) break;

    const name = rawTag.slice(nameStart, cursor).toLowerCase();
    while (cursor < rawTag.length && /\s/.test(rawTag[cursor] ?? "")) cursor += 1;

    let value = "";
    if (rawTag[cursor] === "=") {
      cursor += 1;
      while (cursor < rawTag.length && /\s/.test(rawTag[cursor] ?? "")) cursor += 1;
      const quote = rawTag[cursor];
      if (quote === "\"" || quote === "'") {
        cursor += 1;
        const valueStart = cursor;
        while (cursor < rawTag.length && rawTag[cursor] !== quote) cursor += 1;
        value = rawTag.slice(valueStart, cursor);
        if (rawTag[cursor] === quote) cursor += 1;
      } else {
        const valueStart = cursor;
        while (cursor < rawTag.length && /[^\s>]/.test(rawTag[cursor] ?? "")) cursor += 1;
        value = rawTag.slice(valueStart, cursor).replace(/\/$/, "");
      }
    }

    setSafe(attrs, name, decodeHtmlEntities(value));
  }

  return attrs;
}

export function extractBodyHtml(html: string): string | null {
  const body = findElements(html, "body")[0];
  return body ? body.content : null;
}

export function stripElement(html: string, tagName: string, stripUnterminated = false): string {
  // Linear: splice each element start→close to a space. The old regex was quadratic
  // on unterminated openers (REDOS-3); closes are monotonic, so the first missing
  // close means none follow — return. Boundary-checked so `</script` ≠ `</scripture>`.
  const wanted = tagName.toLowerCase();
  const lower = html.toLowerCase();
  let out = "";
  let cursor = 0;
  for (const tag of findStartTags(html, wanted)) {
    if (tag.start < cursor) continue;
    const closeStart = findCloseTag(lower, `</${wanted}`, tag.end);
    if (closeStart === -1) {
      // No close from here. Default: keep text-before + opener + remainder (unclosed content
      // stays visible — matches the old regex). stripUnterminated: DROP opener + remainder
      // (browser auto-close — an unterminated flow element extends to </body>, so it's chrome).
      return stripUnterminated ? out : out + html.slice(cursor);
    }
    out += `${html.slice(cursor, tag.start)} `;
    cursor = findTagEnd(html, closeStart + 2);
  }
  return out + html.slice(cursor);
}

/** Find `</name` followed by a tag boundary (`>` `/` whitespace) at/after `from`. */
function findCloseTag(lower: string, closeOpen: string, from: number): number {
  let search = from;
  for (;;) {
    const at = lower.indexOf(closeOpen, search);
    if (at === -1) return -1;
    const next = lower[at + closeOpen.length];
    if (next === undefined || next === ">" || next === "/" || next === " " || next === "\t" || next === "\n" || next === "\f" || next === "\r") {
      return at;
    }
    search = at + 1;
  }
}

function setSafe(target: AttributeMap, key: string, value: string): void {
  if (!key || UNSAFE_KEYS.has(key)) return;
  if (target[key] !== undefined) return;
  target[key] = value;
}

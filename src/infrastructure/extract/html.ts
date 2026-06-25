import { collapseWhitespace, decodeHtmlEntities } from "./entities.ts";

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
  const lower = html.toLowerCase();
  const wanted = tagName.toLowerCase();
  return findStartTags(html, wanted).map((tag) => {
    const closeStart = lower.indexOf(`</${wanted}`, tag.end);
    if (closeStart === -1) {
      return { tag, content: html.slice(tag.end), end: html.length };
    }
    const closeEnd = findTagEnd(html, closeStart + 2);
    return { tag, content: html.slice(tag.end, closeStart), end: closeEnd };
  });
}

export function extractVisibleText(html: string): string {
  const body = extractBodyHtml(html) ?? stripElement(html, "head");
  const withoutCode = ["script", "style", "noscript", "template", "svg"]
    .reduce((value, tag) => stripElement(value, tag), body);
  // Linear scanners (not backtracking regex): a near-5MB page of unterminated
  // `<!--`, bare `<`, or `<script>` made the old regexes quadratic (minutes of
  // event-loop block — REDOS-1/2/3). Each scanner below is O(n).
  const text = stripHtmlTags(stripHtmlComments(withoutCode));
  return normalizeFragmentedNumbers(collapseWhitespace(decodeHtmlEntities(text)));
}

// Inline-split markup (`<span>$</span><span>10</span><span>.90</span>`) leaves
// "$ 10 .90" (stripHtmlTags turns each tag into a space). Narrowly collapse only
// number/price fragments: "$ 10"->"$10", "10 .90"->"10.90" (dot must be followed
// by a digit, so "3. item"/"Done. Next" untouched; commas left so lists survive).
function normalizeFragmentedNumbers(text: string): string {
  return text
    .replace(/([€£¥₹$])\s+(\d)/g, "$1$2")
    .replace(/(\d)\s+\.(\d)/g, "$1.$2")
    .replace(/(\d)\s+([€£¥₹])/g, "$1$2");
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

/**
 * Remove `<...>` tag spans linearly, replacing each with a space (matching the
 * old `<[^>]*>` → " "). When a `<` has no following `>`, the rest is literal
 * text — append it once and stop, avoiding the per-`<` EOS rescan that made
 * `<[^>]*>` quadratic on a bare-`<` flood (REDOS-2).
 */
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

function readStartTag(html: string, start: number): HtmlTag | null {
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

function findTagEnd(html: string, from: number): number {
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

function extractBodyHtml(html: string): string | null {
  const body = findElements(html, "body")[0];
  return body ? body.content : null;
}

function stripElement(html: string, tagName: string): string {
  // Linear: splice each element from its start tag to its close, replacing it
  // with a space (matching the old regex's " "). The old
  // `new RegExp(`<tag\b[^>]*>[\s\S]*?</tag>`)` was quadratic on many unterminated
  // openers (REDOS-3). Closes are monotonic, so the first missing close means
  // none follow — return instead of re-scanning. The close is boundary-checked so
  // `</script` does not match `</scripture>`.
  const wanted = tagName.toLowerCase();
  const lower = html.toLowerCase();
  let out = "";
  let cursor = 0;
  for (const tag of findStartTags(html, wanted)) {
    if (tag.start < cursor) continue;
    const closeStart = findCloseTag(lower, `</${wanted}`, tag.end);
    if (closeStart === -1) {
      // No close from here: keep text-before + opener + remainder as-is. The later
      // tag-strip removes the start tag, so an unclosed element's content stays
      // visible (matches the old regex's no-match behavior).
      return out + html.slice(cursor);
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
    if (next === undefined || next === ">" || next === "/" || next === " " || next === "\t" || next === "\n" || next === "\r") {
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

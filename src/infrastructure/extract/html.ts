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

export function findStartTags(html: string, tagName: string): HtmlTag[] {
  const wanted = tagName.toLowerCase();
  const tags: HtmlTag[] = [];
  let offset = 0;

  while (offset < html.length) {
    const start = html.indexOf("<", offset);
    if (start === -1) break;
    const tag = readStartTag(html, start);
    offset = Math.max(start + 1, tag?.end ?? start + 1);
    if (tag?.name === wanted) tags.push(tag);
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
  const text = withoutCode
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ");
  return collapseWhitespace(decodeHtmlEntities(text));
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
  return html.replace(new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "gi"), " ");
}

function setSafe(target: AttributeMap, key: string, value: string): void {
  if (!key || UNSAFE_KEYS.has(key)) return;
  if (target[key] !== undefined) return;
  target[key] = value;
}

import type { ProvenanceError } from "../../domain/result.ts";
import type { StructuredData } from "../../domain/platform.ts";
import { collapseWhitespace, decodeHtmlEntities } from "./entities.ts";
import { extractAppState } from "./app-state.ts";
import { extractImages } from "./images.ts";
import { findElements, findStartTags, firstAttr } from "./html.ts";
import { parseSafeJson, type SafeJsonIssue } from "./safe-json.ts";

interface StringMap {
  [key: string]: string;
}

export interface PageMetadata {
  title?: string;
  structured: StructuredData;
}

export function extractPageMetadata(
  html: string,
  baseUrl: string,
  errors: ProvenanceError[],
): PageMetadata {
  const structured = {} as StructuredData;
  const title = extractTitle(html);
  const canonicalUrl = extractCanonicalUrl(html, baseUrl, errors);
  const jsonLd = extractJsonLd(html, errors);
  const { og, meta } = extractMetaTags(html);
  const appState = extractAppState(html, errors);

  if (canonicalUrl) structured.canonicalUrl = canonicalUrl;
  if (jsonLd !== undefined) structured.jsonLd = jsonLd;
  if (Object.keys(og).length > 0) structured.og = og;
  if (Object.keys(meta).length > 0) structured.meta = meta;
  if (appState !== undefined) structured.appState = appState;
  const images = extractImages(html, baseUrl, og, jsonLd);
  if (images) structured.images = images;

  return { title, structured };
}

function extractTitle(html: string): string | undefined {
  const title = findElements(html, "title")[0]?.content;
  const cleaned = title === undefined
    ? ""
    : collapseWhitespace(decodeHtmlEntities(title.replace(/<[^>]*>/g, " ")));
  return cleaned || undefined;
}

function extractCanonicalUrl(
  html: string,
  baseUrl: string,
  errors: ProvenanceError[],
): string | undefined {
  const href = firstAttr(
    html,
    "link",
    (attrs) => relTokens(attrs.rel).includes("canonical"),
    "href",
  );
  if (!href) return undefined;

  try {
    const parsed = new URL(href, baseUrl);
    parsed.hash = "";
    parsed.username = "";
    parsed.password = "";
    return parsed.href;
  } catch {
    errors.push({
      code: "invalid_canonical_url",
      message: "Canonical URL could not be parsed safely",
    });
    return undefined;
  }
}

function extractJsonLd(html: string, errors: ProvenanceError[]): unknown | undefined {
  const values = [] as unknown[];

  for (const script of findElements(html, "script")) {
    if (!isJsonLdType(script.tag.attrs.type)) continue;
    const source = script.content.trim();
    if (!source) continue;

    const parsed = parseSafeJson(source);
    if (!parsed.ok) {
      pushJsonLdErrors(errors, parsed.issues);
      continue;
    }
    values.push(parsed.value);
    pushJsonLdErrors(errors, parsed.issues);
  }

  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
}

function extractMetaTags(html: string): {
  og: StringMap;
  meta: StringMap;
} {
  const og = {} as StringMap;
  const meta = {} as StringMap;

  for (const tag of findStartTags(html, "meta")) {
    const key = tag.attrs.property || tag.attrs.name;
    const value = tag.attrs.content;
    if (!key || value === undefined) continue;

    const normalized = key.toLowerCase();
    if (!isSafeRecordKey(normalized)) continue;

    if (normalized.startsWith("og:")) {
      og[normalized] = value;
    } else {
      meta[normalized] = value;
    }
  }

  return { og, meta };
}

function isJsonLdType(type: string | undefined): boolean {
  return (type ?? "").toLowerCase().split(";")[0]?.trim() === "application/ld+json";
}

function relTokens(rel: string | undefined): string[] {
  return (rel ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

function isSafeRecordKey(key: string): boolean {
  return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

function pushJsonLdErrors(errors: ProvenanceError[], issues: SafeJsonIssue[]): void {
  for (const issue of issues) {
    errors.push({
      code: issue.code === "invalid_json" ? "invalid_json_ld" : "unsafe_json_key",
      message: `JSON-LD: ${issue.message}`,
    });
  }
}

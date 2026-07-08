import type { Output } from "../../domain/tier.ts";
import type { StructuredData } from "../../domain/platform.ts";
import { stripHtmlTags } from "../../infrastructure/extract/html.ts";
import { isPinDetailPage } from "../classify.ts";

/**
 * JSON-LD schema.org types whose `name`/`headline`/`title` reliably IS the page's
 * subject (job/article/product). For these the structured-data title is more
 * specific than `<title>` — e.g. an Ashby iframe reports `<title>Careers — E2B
 * </title>` while its JobPosting JSON-LD carries the real title. Organization/
 * WebSite are excluded so a homepage `<title>` beats a generic org name.
 * SocialMediaPosting is intentionally NOT here: a social post is frequently an
 * embed on an unrelated page, not the subject — surfacing a pin's caption is
 * handled separately in leadDescription (pass 2) so it can never steal the title.
 */
export const CONTENT_TITLE_TYPES = new Set([
  "jobposting", "article", "newsarticle", "blogposting", "techarticle",
  "scholarlyarticle", "report", "product", "event", "recipe", "course",
  "review", "webapplication", "softwareapplication", "videoobject",
  "musicrecording", "book",
]);

/** Normalize a schema.org @type to its short lowercase form (e.g. "jobposting"). */
function shortSchemaType(value: string): string {
  const lower = value.toLowerCase().replace(/^https?:\/\/schema\.org\//, "");
  return lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
}

/** Short lowercase schema.org @types on a node (short, full-IRI, and array forms). */
function shortTypes(node: Record<string, unknown> | null): string[] {
  if (!node) return [];
  const type = node["@type"];
  const types = Array.isArray(type) ? type.map(String) : type === undefined ? [] : [String(type)];
  return types.map(shortSchemaType);
}

/** A node whose @type is a page-subject type (job/article/product/pin/...). */
export function isContentNode(node: Record<string, unknown> | null): boolean {
  return shortTypes(node).some((t) => CONTENT_TITLE_TYPES.has(t));
}

/** Treat a value as an array (undefined → [], non-array → [value]). */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

/** The child nodes of a schema.org @graph wrapper (array or single node). */
export function graphNodes(graph: unknown): Record<string, unknown>[] {
  if (Array.isArray(graph)) {
    return graph.filter((g): g is Record<string, unknown> => g !== null && typeof g === "object");
  }
  if (graph !== null && typeof graph === "object") return [graph as Record<string, unknown>];
  return [];
}

function stripHtml(html: string): string {
  // Linear tag strip (REDOS-2): the old /<[^>]+>/g is quadratic on a bare-`<` flood.
  return stripHtmlTags(html).replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

/** Flatten JSON-LD into content-node candidates in document order. A page may have
 *  several ld+json scripts and any one may itself parse to an array of nodes, so
 *  flatten one level (extractJsonLd nests as [[...], node]); then descend @graph.
 *  Arrays are never treated as nodes — only records are. */
export function candidateNodes(jsonLd: unknown): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  for (const outer of asArray(jsonLd)) {
    for (const item of asArray(outer)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const node = item as Record<string, unknown>;
      nodes.push(node);
      for (const child of graphNodes(node["@graph"])) nodes.push(child);
    }
  }
  return nodes;
}

/**
 * The leading description for output:raw — the page's primary content when the
 * visible body is chrome/empty (a vscdn/Netflix JD, a Pinterest pin caption).
 *
 * Pass 1 takes a real description from any content node. Pass 2 falls back to a
 * SocialMediaPosting's articleBody ONLY on an actual pin detail page
 * (pinterest .../pin/<id>/ or pin.it) with no higher-priority content node — the
 * post IS the subject there. Restricted to real pin pages so an embedded post on
 * an article, a landing page, a board/profile, or a lookalike host can never lead.
 * An Article's articleBody equals its visible body, so it is never used as a lead.
 */
function leadDescription(structured: StructuredData, url: string): string | undefined {
  if (!structured.jsonLd) return undefined;
  const nodes = candidateNodes(structured.jsonLd);
  // Pass 1: a real description lead from any content node (concise, non-dominating).
  for (const node of nodes) {
    if (!isContentNode(node)) continue;
    const desc = node?.description;
    if (typeof desc === "string" && desc.length > 50) return stripHtml(desc);
  }
  // Pass 2: a pin's caption, only on an actual pin detail page whose only content
  // node is the post itself. A higher-priority content node suppresses the fallback
  // — but a co-typed post (e.g. @type ["SocialMediaPosting","Article"]) is the pin,
  // so exclude social postings from the suppression.
  const hasHigherContent = nodes.some(
    (n) => isContentNode(n) && !shortTypes(n).includes("socialmediaposting"),
  );
  if (!isPinDetailPage(url) || hasHigherContent) return undefined;
  const postings = nodes.filter((n) => shortTypes(n).includes("socialmediaposting"));
  // Prefer the posting that IS this pin (its url/mainEntityOfPage references the
  // fetched pin id) over a related/embedded pin; fall back to the first posting.
  const pinId = pinIdFromUrl(url);
  const chosen = postings.find((n) => referencesPinId(n, pinId)) ?? postings[0];
  const body = chosen?.articleBody;
  if (typeof body === "string" && body.trim()) return stripHtml(body);
  return undefined;
}

/** The numeric pin id in a pinterest .../pin/<id>/ URL, if present. */
function pinIdFromUrl(url: string): string | undefined {
  return url.match(/\/pin\/(\d+)/)?.[1];
}

/** Whether a SocialMediaPosting node IS the fetched pin — one of its reference
 *  URLs (node.url; mainEntityOfPage as a string, or its "@id"/"url") is a genuine
 *  Pinterest pin-detail URL with the same id. Reuses isPinDetailPage so a non-detail
 *  reference (/alice/pin/123/) or one that merely contains the id never matches. */
function referencesPinId(node: Record<string, unknown> | undefined, pinId: string | undefined): boolean {
  if (!pinId || !node) return false;
  const refs: string[] = [];
  if (typeof node["@id"] === "string") refs.push(node["@id"]);
  if (typeof node.url === "string") refs.push(node.url);
  const mep = node.mainEntityOfPage;
  if (typeof mep === "string") refs.push(mep);
  else if (mep && typeof mep === "object") {
    const obj = mep as Record<string, unknown>;
    if (typeof obj["@id"] === "string") refs.push(obj["@id"]);
    if (typeof obj.url === "string") refs.push(obj.url);
  }
  return refs.some((r) => isPinDetailPage(r) && pinIdFromUrl(r) === pinId);
}

/** Shape the Tier-1 output string for the requested output mode. */
export function buildPayload(output: Output, structured: StructuredData, text: string, url: string): string {
  if (output === "extract") return JSON.stringify(structured, null, 2);
  const parts: string[] = [];
  const desc = leadDescription(structured, url);
  if (desc) parts.push(desc);
  if (text) parts.push(text);
  return parts.join("\n\n");
}

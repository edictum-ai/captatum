import { STATUS_CODES } from "node:http";
import type { FetcherResult } from "../ports/fetcher.ts";
import type { Output } from "../../domain/tier.ts";
import { sha256Hex, type ProvenanceError, type Result } from "../../domain/result.ts";
import { decodeBody } from "../../infrastructure/http/body.ts";
import { stripHtmlTags } from "../../infrastructure/extract/html.ts";
import type { StructuredData } from "../../domain/platform.ts";
import type { ShellGateEvidence } from "../../domain/shell-gate.ts";

/** REDOS-4: char budget for synchronous HTML extraction input. The scanners are
 *  O(n); 1M chars is far beyond any real page's structured-data region. */
const EXTRACT_CHAR_BUDGET = 1_000_000;

export interface HtmlExtractionInput {
  html: string;
  url: string;
  contentType?: string;
}

export interface HtmlExtraction {
  title?: string;
  text: string;
  structured: StructuredData;
  shellGate: ShellGateEvidence;
  errors: ProvenanceError[];
}

export type HtmlExtractor = (input: HtmlExtractionInput) => HtmlExtraction;

export interface Tier1ExtractInput {
  requestedUrl: string;
  fetchResult: FetcherResult;
  extractHtml: HtmlExtractor;
  durationMs: number;
  fetchMs?: number;
  output?: Output;
  fetchedAt?: string;
}

export async function extractTier1FromFetchResult(input: Tier1ExtractInput): Promise<Result> {
  const fullHtml = await decodeBody(input.fetchResult.bodyStream, input.fetchResult.contentType);
  // REDOS-4: cap the HTML passed to the synchronous extractor. The scanners are
  // O(n); 1MB is far beyond any real page's structured-data region, and content
  // beyond it is body text the extractor already truncates internally.
  const extractionHtml = fullHtml.length > EXTRACT_CHAR_BUDGET
    ? capAtSafeBoundary(fullHtml, EXTRACT_CHAR_BUDGET)
    : fullHtml;
  const truncated = fullHtml.length > EXTRACT_CHAR_BUDGET;
  const extraction = input.extractHtml({
    html: extractionHtml,
    url: input.fetchResult.finalUrl || input.requestedUrl,
    contentType: input.fetchResult.contentType,
  });
  const structured = hasStructuredFields(extraction.structured)
    ? extraction.structured
    : undefined;
  const output = input.output ?? "raw";
  const title = preferredTitle(extraction.title, extraction.structured);

  return {
    url: input.requestedUrl,
    bytes: input.fetchResult.bytes,
    code: input.fetchResult.status,
    codeText: STATUS_CODES[input.fetchResult.status] ?? "",
    durationMs: input.durationMs,
    result: resultPayload(output, extraction),
    schemaVersion: 1,
    finalUrl: input.fetchResult.finalUrl,
    redirects: input.fetchResult.redirects,
    tier: 1,
    output,
    platform: { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier1" },
    jsRequired: extraction.shellGate.jsRequired,
    resolvedVia: resolvedVia(extraction),
    attempts: [{
      step: 1,
      tier: 1,
      outcome: extraction.shellGate.jsRequired ? "escalate" : "ok",
      status: input.fetchResult.status,
      durationMs: input.fetchMs ?? input.durationMs,
      bytes: input.fetchResult.bytes,
      reason: extraction.shellGate.reason,
    }],
    contentType: input.fetchResult.contentType,
    title,
    contentSha256: sha256Hex(fullHtml),
    structured,
    timings: { totalMs: input.durationMs, fetchMs: input.fetchMs ?? input.durationMs },
    errors: [
      ...extraction.errors,
      ...(input.fetchResult.truncated
        ? [{ code: "max_bytes", message: "Content truncated at the byte cap" }]
        : []),
      ...(truncated
        ? [{ code: "extract_truncated", message: `Extraction input capped at ${EXTRACT_CHAR_BUDGET} chars (REDOS-4)` } as ProvenanceError]
        : []),
    ],
    ...(input.fetchedAt !== undefined ? { fetchedAt: input.fetchedAt } : {}),
  };
}

/** Slice HTML at a safe boundary: walk back past a <script>/<style>/<template>/
 *  <noscript>/<svg> opener so stripElement sees a well-formed element. */
function capAtSafeBoundary(html: string, budget: number): string {
  let cut = budget;
  const lastOpen = html.lastIndexOf("<", cut);
  if (lastOpen > cut - 30) {
    // Avoid cutting mid-tag (e.g. "<scr" at the boundary).
    cut = lastOpen;
  }
  // Check if we're inside a script/style/template/noscript/svg block.
  const before = html.slice(0, cut);
  for (const tag of ["script", "style", "template", "noscript", "svg"]) {
    const openIdx = before.lastIndexOf(`<${tag}`);
    if (openIdx !== -1) {
      const closeIdx = before.lastIndexOf(`</${tag}`, cut);
      if (closeIdx < openIdx) {
        // Inside an unclosed block — cut before the opener.
        cut = openIdx;
        break;
      }
    }
  }
  return html.slice(0, Math.max(cut, 0));
}

function hasStructuredFields(structured: StructuredData): boolean {
  return Object.keys(structured).length > 0;
}

/**
 * JSON-LD schema.org types whose `name`/`headline`/`title` IS the page's
 * subject (a job, an article, a product). For these, the structured-data title
 * is more specific than the page `<title>` — e.g. an Ashby board embedded in an
 * iframe reports `<title>Careers — E2B</title>` while the iframe's JobPosting
 * JSON-LD carries the real title ("Platform Engineer"). Organization/WebSite
 * are intentionally excluded so a homepage `<title>` is kept over a generic
 * org name.
 */
const CONTENT_TITLE_TYPES = new Set([
  "jobposting", "article", "newsarticle", "blogposting", "techarticle",
  "scholarlyarticle", "report", "product", "event", "recipe", "course",
  "review", "webapplication", "softwareapplication", "videoobject",
  "musicrecording", "book",
]);

/**
 * Pick the best title. When a content-bearing JSON-LD node exists, prefer its
 * title — but keep the raw `<title>` when it already contains the JSON-LD title
 * (it is a superset and usually richer, e.g. "Platform Engineer @ E2B"). This
 * fixes iframe/embedded-widget pages whose `<title>` is the host page, not the
 * embedded content.
 */
export function preferredTitle(rawTitle: string | undefined, structured: StructuredData): string | undefined {
  const fromJsonLd = contentTitleFromJsonLd(structured.jsonLd);
  if (!fromJsonLd) return rawTitle;
  if (!rawTitle) return fromJsonLd;
  return rawTitle.toLowerCase().includes(fromJsonLd.toLowerCase()) ? rawTitle : fromJsonLd;
}

function contentTitleFromJsonLd(jsonLd: unknown): string | undefined {
  for (const item of asArray(jsonLd)) {
    const node = item as Record<string, unknown> | null;
    if (!node || typeof node !== "object") continue;
    const direct = contentTitleOfNode(node);
    if (direct) return direct;
    // schema.org @graph wrapper (array or single node): descend one level.
    for (const child of graphNodes(node["@graph"])) {
      const nested = contentTitleOfNode(child);
      if (nested) return nested;
    }
  }
  return undefined;
}

function graphNodes(graph: unknown): Record<string, unknown>[] {
  if (Array.isArray(graph)) {
    return graph.filter((g): g is Record<string, unknown> => g !== null && typeof g === "object");
  }
  if (graph !== null && typeof graph === "object") return [graph as Record<string, unknown>];
  return [];
}

function isContentNode(node: Record<string, unknown> | null): boolean {
  if (!node || typeof node !== "object") return false;
  const type = node["@type"];
  const types = Array.isArray(type) ? type.map(String) : type === undefined ? [] : [String(type)];
  // Accept short ("JobPosting") and full-IRI ("https://schema.org/JobPosting") forms.
  return types.some((t) => CONTENT_TITLE_TYPES.has(shortSchemaType(t)));
}

function contentTitleOfNode(node: Record<string, unknown> | null): string | undefined {
  if (!node || !isContentNode(node)) return undefined;
  for (const key of ["title", "name", "headline"]) {
    const value = node[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Normalize a schema.org @type to its short lowercase form (e.g. "jobposting"). */
function shortSchemaType(value: string): string {
  const lower = value.toLowerCase().replace(/^https?:\/\/schema\.org\//, "");
  return lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function resultPayload(output: Output, extraction: HtmlExtraction): string {
  if (output === "extract") {
    return JSON.stringify(extraction.structured, null, 2);
  }
  // Content-bearing JSON-LD description leads; body text supplements (vscdn/netflix).
  const desc = jsonLdDescription(extraction.structured);
  const parts: string[] = [];
  if (desc) parts.push(desc);
  if (extraction.text) parts.push(extraction.text);
  return parts.join("\n\n");
}

function jsonLdDescription(structured: StructuredData): string | undefined {
  if (!structured.jsonLd) return undefined;
  const items = Array.isArray(structured.jsonLd) ? structured.jsonLd : [structured.jsonLd];
  for (const item of items) {
    const node = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    // Content-bearing @type only — a WebSite/Organization description can't outrank
    // the real body text now that the description leads output:raw.
    if (!isContentNode(node)) continue;
    const desc = node?.description;
    if (typeof desc === "string" && desc.length > 50) return stripHtml(desc);
  }
  return undefined;
}

function stripHtml(html: string): string {
  // Linear tag strip (REDOS-2): the old /<[^>]+>/g is quadratic on a bare-`<` flood.
  return stripHtmlTags(html).replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

function resolvedVia(extraction: HtmlExtraction): string {
  if (extraction.shellGate.reason === "empty-spa-shell") return "tier1-shell-gate";
  if (extraction.structured.jsonLd !== undefined) return "tier1-jsonld";
  if (extraction.structured.appState !== undefined) return "tier1-app-state";
  if (extraction.structured.og !== undefined || extraction.structured.meta !== undefined) {
    return "tier1-meta";
  }
  return "tier1-html";
}

import { STATUS_CODES } from "node:http";
import type { FetcherResult } from "../ports/fetcher.ts";
import type { Output } from "../../domain/tier.ts";
import { sha256Hex, type ProvenanceError, type Result } from "../../domain/result.ts";
import { decodeBody, isHtmlContentType, isJsonContentType } from "../../infrastructure/http/body.ts";
import type { StructuredData } from "../../domain/platform.ts";
import type { ShellGateEvidence } from "../../domain/shell-gate.ts";
import { buildPayload, candidateNodes, isContentNode } from "./tier1-payload.ts";

/** REDOS-4: char budget for synchronous HTML extraction input. The scanners are
 *  O(n); 1M chars is far beyond any real page's structured-data region. */
const EXTRACT_CHAR_BUDGET = 5_000_000; // covers deep-content pages (Jira REST article sits at ~2.8MB); scanners are O(n) (REDOS-5)

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
  // O(n); 1MB is far beyond any real page's structured-data region.
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
    result: buildPayload(output, extraction.structured, extraction.text, input.fetchResult.finalUrl || input.requestedUrl),
    schemaVersion: 1,
    finalUrl: input.fetchResult.finalUrl,
    redirects: input.fetchResult.redirects,
    tier: 1,
    output,
    platform: { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier1" },
    jsRequired: extraction.shellGate.jsRequired,
    resolvedVia: resolvedVia(extraction, input.fetchResult.contentType),
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
 * Pick the best title. When a content-bearing JSON-LD node exists, prefer its
 * title — but keep the raw `<title>` when it already contains the JSON-LD title
 * (a richer superset, e.g. "Platform Engineer @ E2B"). Fixes iframe/embed pages
 * whose `<title>` is the host page, not the embedded content.
 */
export function preferredTitle(rawTitle: string | undefined, structured: StructuredData): string | undefined {
  const fromJsonLd = contentTitleFromJsonLd(structured.jsonLd);
  if (!fromJsonLd) return rawTitle;
  if (!rawTitle) return fromJsonLd;
  return rawTitle.toLowerCase().includes(fromJsonLd.toLowerCase()) ? rawTitle : fromJsonLd;
}

function contentTitleFromJsonLd(jsonLd: unknown): string | undefined {
  for (const node of candidateNodes(jsonLd)) {
    const title = contentTitleOfNode(node);
    if (title) return title;
  }
  return undefined;
}

function contentTitleOfNode(node: Record<string, unknown> | null): string | undefined {
  if (!node || !isContentNode(node)) return undefined;
  for (const key of ["title", "name", "headline"]) {
    const value = node[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function resolvedVia(extraction: HtmlExtraction, contentType?: string): string {
  // A non-HTML body is returned raw (no HTML extraction) — label it by content family, not "tier1-html".
  if (!isHtmlContentType(contentType)) {
    return isJsonContentType(contentType) ? "tier1-json" : "tier1-text";
  }
  if (extraction.shellGate.reason === "empty-spa-shell") return "tier1-shell-gate";
  if (extraction.structured.jsonLd !== undefined) return "tier1-jsonld";
  if (extraction.structured.appState !== undefined) return "tier1-app-state";
  if (extraction.structured.og !== undefined || extraction.structured.meta !== undefined) {
    return "tier1-meta";
  }
  return "tier1-html";
}

import { STATUS_CODES } from "node:http";
import type { FetcherResult } from "../ports/fetcher.ts";
import type { Output } from "../../domain/tier.ts";
import type { ProvenanceError, Result } from "../../domain/result.ts";
import type { StructuredData } from "../../domain/platform.ts";
import type { ShellGateEvidence } from "../../domain/shell-gate.ts";

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
  const html = await new Response(input.fetchResult.bodyStream).text();
  const extraction = input.extractHtml({
    html,
    url: input.fetchResult.finalUrl || input.requestedUrl,
    contentType: input.fetchResult.contentType,
  });
  const structured = hasStructuredFields(extraction.structured)
    ? extraction.structured
    : undefined;
  const output = input.output ?? "raw";

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
    title: extraction.title,
    structured,
    timings: { totalMs: input.durationMs, fetchMs: input.fetchMs ?? input.durationMs },
    errors: extraction.errors,
    ...(input.fetchedAt !== undefined ? { fetchedAt: input.fetchedAt } : {}),
  };
}

function hasStructuredFields(structured: StructuredData): boolean {
  return Object.keys(structured).length > 0;
}

function resultPayload(output: Output, extraction: HtmlExtraction): string {
  if (output === "extract") {
    return JSON.stringify(extraction.structured, null, 2);
  }

  const parts: string[] = [];
  if (extraction.text) parts.push(extraction.text);
  const desc = jsonLdDescription(extraction.structured);
  if (desc) parts.push(desc);
  return parts.join("\n\n");
}

function jsonLdDescription(structured: StructuredData): string | undefined {
  if (!structured.jsonLd) return undefined;
  const items = Array.isArray(structured.jsonLd) ? structured.jsonLd : [structured.jsonLd];
  for (const item of items) {
    if (item && typeof item === "object" && "description" in item) {
      const desc = (item as Record<string, unknown>).description;
      if (typeof desc === "string" && desc.length > 50) return stripHtml(desc);
    }
  }
  return undefined;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
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

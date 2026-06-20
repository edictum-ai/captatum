import { STATUS_CODES } from "node:http";
import type { FetcherPort, FetcherResult, RejectResult } from "../ports/fetcher.ts";
import type { ClockPort } from "../ports/clock.ts";
import type { RenderPort } from "../ports/renderer.ts";
import { TransformError, type TransformPort, type TransformResult } from "../ports/transformer.ts";
import type { Platform } from "../../domain/platform.ts";
import { computeProvenanceHash, type Result } from "../../domain/result.ts";
import {
  extractTier1FromFetchResult,
  type HtmlExtractor,
} from "./tier1-extract.ts";
import { maybeRender } from "./render.ts";
import { resolveAshbyEmbedUrl } from "../../infrastructure/ashby/embed-resolver.ts";
import { fallbackExcerpt } from "./result-excerpt.ts";
import { transformContent } from "./transform-content.ts";
import {
  DEFAULT_SMART_FETCH_DEFAULTS,
  normalizeSmartFetchInput,
  type NormalizedSmartFetchInput,
  type SmartFetchDefaults,
} from "./smart-fetch-input.ts";

const GENERIC_PLATFORM: Platform = {
  adapterId: "generic",
  label: "Generic HTML",
  detectedFrom: "tier1",
};

export interface SmartFetchContext {
  fetchedAt?: string;
}

export interface SmartFetchDeps {
  fetcher: FetcherPort;
  extractHtml: HtmlExtractor;
  clock: ClockPort;
  transformer?: TransformPort;
  renderer?: RenderPort;
  defaults?: Partial<SmartFetchDefaults>;
}

export class SmartFetchUseCase {
  private readonly fetcher: FetcherPort;
  private readonly extractHtml: HtmlExtractor;
  private readonly clock: ClockPort;
  private readonly transformer?: TransformPort;
  private readonly renderer?: RenderPort;
  private readonly defaults: SmartFetchDefaults;

  constructor(deps: SmartFetchDeps) {
    this.fetcher = deps.fetcher;
    this.extractHtml = deps.extractHtml;
    this.clock = deps.clock;
    this.transformer = deps.transformer;
    this.renderer = deps.renderer;
    this.defaults = { ...DEFAULT_SMART_FETCH_DEFAULTS, ...deps.defaults };
  }

  async execute(input: unknown, context: SmartFetchContext = {}): Promise<Result> {
    const request = normalizeSmartFetchInput(input, this.defaults);
    const startMs = this.clock.nowMs();
    const fetchStartMs = startMs;
    // Tier-2: resolve Ashby-embed careers pages (e2b.dev/careers?ashby_jid=…)
    // to the direct Ashby job URL, which serves a clean JobPosting JSON-LD at Tier-1.
    const ashbyResolved = await resolveAshbyEmbedUrl(request.url, this.fetcher, {
      maxBytes: request.maxBytes,
      timeoutMs: request.timeoutMs,
      maxHops: request.maxHops,
    });
    const fetchUrl = ashbyResolved ?? request.url;
    let fetched: FetcherResult | RejectResult;
    try {
      fetched = await this.fetcher.fetchGuarded(fetchUrl, {
        maxBytes: request.maxBytes,
        timeoutMs: request.timeoutMs,
        maxHops: request.maxHops,
      });
    } catch (error) {
      fetched = unexpectedReject(error);
    }
    const fetchMs = elapsed(fetchStartMs, this.clock.nowMs());

    if ("rejected" in fetched) {
      return rejectResult(request, fetched, fetchMs, fetchMs, context.fetchedAt);
    }

    const base = await extractTier1FromFetchResult({
      requestedUrl: request.url,
      fetchResult: fetched,
      extractHtml: this.extractHtml,
      durationMs: fetchMs,
      fetchMs,
      output: "raw",
      fetchedAt: context.fetchedAt,
    });
    if (ashbyResolved) {
      base.platform = { adapterId: "ashby-embed", label: "Ashby embed", detectedFrom: "ashby_jid" };
    }
    stampTotals(base, elapsed(startMs, this.clock.nowMs()), fetchMs);
    const resolved = await maybeRender({
      result: base,
      request,
      renderer: this.renderer,
      fetcher: this.fetcher,
      extractHtml: this.extractHtml,
      clock: this.clock,
    });
    return await this.applyOutputMode(resolved, request, startMs, fetchMs);
  }

  private async applyOutputMode(
    base: Result,
    request: NormalizedSmartFetchInput,
    startMs: number,
    fetchMs: number,
  ): Promise<Result> {
    if (request.requestedOutput === "raw") {
      base.output = "raw";
      stampTotals(base, elapsed(startMs, this.clock.nowMs()), fetchMs);
      return base;
    }

    if (!this.transformer) {
      base.output = "raw";
      base.transform = { provider: "none", reason: "unconfigured" };
      base.timings.transformMs = 0;
      base.result = fallbackExcerpt(base.result);
      stampTotals(base, elapsed(startMs, this.clock.nowMs()), fetchMs);
      return base;
    }

    const transformStartMs = this.clock.nowMs();
    let transformed: TransformResult;
    let transformMs = 0;
    try {
      transformed = await this.transformer.transform({
        mode: request.requestedOutput === "extract" ? "extract" : "summarize",
        output: request.requestedOutput,
        content: transformContent(base),
        prompt: request.prompt,
        sourceUrl: base.finalUrl,
        schema: request.schema,
        budget: request.budget,
        transform: request.transform,
      });
      transformMs = elapsed(transformStartMs, this.clock.nowMs());
    } catch (error) {
      transformMs = elapsed(transformStartMs, this.clock.nowMs());
      base.output = "raw";
      base.transform = { provider: "none", reason: "failed", latencyMs: transformMs };
      base.timings.transformMs = transformMs;
      base.errors.push({ code: transformErrorCode(error), message: errorMessage(error, "Transform failed") });
      base.result = fallbackExcerpt(base.result);
      stampTotals(base, elapsed(startMs, this.clock.nowMs()), fetchMs);
      return base;
    }
    base.result = transformed.result;
    base.output = transformed.info.provider === "none" ? "raw" : request.requestedOutput;
    base.transform = transformed.info;
    // Non-fatal: primary model(s) failed and the router fell back — surface it so
    // status becomes `partial` (not `pass`) and the caller knows the output may be lower quality.
    if (transformed.info.fallbackFrom) {
      base.errors.push({
        code: "transform_model_fallback",
        message: `Primary model(s) ${transformed.info.fallbackFrom} failed; produced this ${base.output} with ${transformed.info.model ?? transformed.info.provider}. It may be lower quality — retry if it looks off.`,
      });
    }
    // Token-safe: bound a raw fallback so a failed summary does not dump the whole page.
    if (transformed.info.provider === "none") base.result = fallbackExcerpt(base.result);
    // Non-fatal advisory: extract returned parsed JSON that violated the requested schema.
    if (transformed.info.schemaIssue) {
      base.errors.push({ code: "extract_schema_invalid", message: transformed.info.schemaIssue });
    }
    base.timings.transformMs = transformMs;
    stampTotals(base, elapsed(startMs, this.clock.nowMs()), fetchMs);
    return base;
  }
}

export function createSmartFetchUseCase(deps: SmartFetchDeps): SmartFetchUseCase {
  return new SmartFetchUseCase(deps);
}

function rejectResult(
  request: NormalizedSmartFetchInput,
  rejected: RejectResult,
  fetchMs: number,
  totalMs: number,
  fetchedAt?: string,
): Result {
  return {
    url: request.url,
    bytes: 0,
    code: 0,
    codeText: "FETCH_REJECTED",
    durationMs: totalMs,
    result: rejected.message,
    schemaVersion: 1,
    finalUrl: request.url,
    redirects: [],
    tier: "error",
    output: request.requestedOutput,
    platform: GENERIC_PLATFORM,
    jsRequired: false,
    resolvedVia: "guarded-fetch",
    attempts: [{
      step: 1,
      tier: 1,
      outcome: "block",
      durationMs: fetchMs,
      reason: rejected.code,
    }],
    contentType: "",
    timings: { totalMs, fetchMs },
    errors: [{ code: rejected.code, message: rejected.message }],
    ...(fetchedAt !== undefined ? { fetchedAt } : {}),
  };
}

function stampTotals(result: Result, totalMs: number, fetchMs: number): void {
  result.durationMs = totalMs;
  result.timings.totalMs = totalMs;
  result.timings.fetchMs = fetchMs;
  result.codeText = result.code === 0 ? result.codeText : STATUS_CODES[result.code] ?? "";
  result.provenanceHash = computeProvenanceHash(result);
}

function unexpectedReject(error: unknown): RejectResult {
  return {
    rejected: true,
    code: "network_error",
    message: errorMessage(error, "Fetch failed before a safe response was available"),
  };
}

function transformErrorCode(error: unknown): string {
  return error instanceof TransformError ? error.code : "transform_failed";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message
    ? error.message
    : fallback;
}

function elapsed(startMs: number, endMs: number): number {
  return Math.max(0, Math.round(endMs - startMs));
}

import type { FetcherPort, FetcherResult, RejectResult } from "../ports/fetcher.ts";
import type { ClockPort } from "../ports/clock.ts";
import type { RenderPort } from "../ports/renderer.ts";
import { TransformError, type TransformPort, type TransformResult } from "../ports/transformer.ts";
import type { Platform } from "../../domain/platform.ts";
import { type Result } from "../../domain/result.ts";
import type { CaptatumContext } from "../ports/captatum-context.ts";
import type { PlatformAdapterRegistry } from "../ports/platform-adapter.ts";
import { createAdapterRegistry } from "../adapters.ts";
import { tryTier2ShortCircuit } from "./tier2.ts";
import { elapsed, stampTotals, unexpectedReject } from "./captatum-util.ts";
import {
  extractTier1FromFetchResult,
  type HtmlExtractor,
} from "./tier1-extract.ts";
import { maybeRender } from "./render.ts";
import { stampAntibotChallenge } from "../antibot.ts";
import { resolveAshbyEmbedUrl } from "../../infrastructure/ashby/embed-resolver.ts";
import { errorMessage, fallbackExcerpt, transformErrorCode } from "./result-excerpt.ts";
import { stripAdTrackerUrlsForLlm, transformContent } from "./transform-content.ts";
import {
  DEFAULT_CAPTATUM_DEFAULTS,
  normalizeCaptatumInput,
  type NormalizedCaptatumInput,
  type CaptatumDefaults,
} from "./captatum-input.ts";

const GENERIC_PLATFORM: Platform = { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier1" };

export interface CaptatumDeps {
  fetcher: FetcherPort;
  extractHtml: HtmlExtractor;
  clock: ClockPort;
  transformer?: TransformPort;
  renderer?: RenderPort;
  /** Tier-2 platform-adapter registry; defaults to createAdapterRegistry() (ATS list APIs). */
  adapters?: PlatformAdapterRegistry;
  defaults?: Partial<CaptatumDefaults>;
}

export class CaptatumUseCase {
  private readonly fetcher: FetcherPort;
  private readonly extractHtml: HtmlExtractor;
  private readonly clock: ClockPort;
  private readonly transformer?: TransformPort;
  private readonly renderer?: RenderPort;
  private readonly adapters: PlatformAdapterRegistry;
  private readonly defaults: CaptatumDefaults;

  constructor(deps: CaptatumDeps) {
    this.fetcher = deps.fetcher;
    this.extractHtml = deps.extractHtml;
    this.clock = deps.clock;
    this.transformer = deps.transformer;
    this.renderer = deps.renderer;
    this.adapters = deps.adapters ?? createAdapterRegistry();
    this.defaults = { ...DEFAULT_CAPTATUM_DEFAULTS, ...deps.defaults };
    this.defaults.defaultOutput = deps.defaults?.defaultOutput ?? (!deps.transformer || (typeof deps.transformer.hasProvider === "function" && !deps.transformer.hasProvider()) ? "raw" : "summary");
  }

  get defaultOutput() { return this.defaults.defaultOutput; }

  async execute(input: unknown, context: CaptatumContext = {}): Promise<Result> {
    const request = normalizeCaptatumInput(input, this.defaults);
    const startMs = this.clock.nowMs();
    // Tier-2 short-circuit: a registered platform adapter (ATS list APIs) may resolve the URL to clean JSON, bypassing the generic fetch/render.
    const tier2 = await tryTier2ShortCircuit({ adapters: this.adapters, url: request.url, now: new Date(startMs).toISOString(), fetcher: this.fetcher, clock: this.clock, fetchedAt: context.fetchedAt, maxBytes: request.maxBytes, timeoutMs: request.timeoutMs, maxHops: request.maxHops });
    if (tier2) return this.applyOutputMode(tier2, request, startMs, tier2.timings.fetchMs);
    // Re-base the Tier-1 timer after the Tier-2 short-circuit, so a miss that did a real API fetch (404/truncated/timeout) doesn't inflate the Tier-1 attempt's fetchMs. `startMs` stays the total baseline.
    const fetchStartMs = this.clock.nowMs();
    // Tier-2: resolve Ashby-embed careers pages (?ashby_jid=…) to the direct Ashby job URL (clean JobPosting JSON-LD at Tier-1).
    // `context.signal` (the bulk wall deadline) threads into both live fetches below; the Tier-2 board short-circuit above does no fetch for a non-board URL (bulk pre-rejects board roots).
    // Shared fetch opts for both live fetches below. `signal` is included ONLY when present so a
    // single-fetch call (no context.signal) produces byte-identical opts (additive guarantee).
    const fetchOpts = {
      maxBytes: request.maxBytes,
      timeoutMs: request.timeoutMs,
      maxHops: request.maxHops,
      ...(context.signal ? { signal: context.signal } : {}),
    };
    const ashbyResolved = await resolveAshbyEmbedUrl(request.url, this.fetcher, fetchOpts);
    const fetchUrl = ashbyResolved ?? request.url;
    let fetched: FetcherResult | RejectResult;
    try {
      fetched = await this.fetcher.fetchGuarded(fetchUrl, fetchOpts);
    } catch (error) {
      fetched = unexpectedReject(error);
    }
    const fetchedNow = this.clock.nowMs();
    const fetchMs = elapsed(fetchStartMs, fetchedNow);

    if ("rejected" in fetched) {
      // totalMs spans from startMs (incl. the Tier-2 attempt); fetchMs stays scoped to the Tier-1 fetch.
      return rejectResult(request, fetched, fetchMs, elapsed(startMs, fetchedNow), context.fetchedAt);
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
    // #41 Half A: a challenge wall is gated, not content — label it (gateReason
    // "captcha") and skip the futile render/summarize (Half B bypass isn't viable).
    const isChallenge = stampAntibotChallenge(base, fetched);
    stampTotals(base, elapsed(startMs, this.clock.nowMs()), fetchMs);
    const resolved = isChallenge
      ? base
      : await maybeRender({
        result: base,
        request,
        renderer: this.renderer,
        fetcher: this.fetcher,
        extractHtml: this.extractHtml,
        clock: this.clock,
        ...(context.signal ? { signal: context.signal } : {}),
      });
    return await this.applyOutputMode(resolved, request, startMs, fetchMs);
  }

  private async applyOutputMode(
    base: Result,
    request: NormalizedCaptatumInput,
    startMs: number,
    fetchMs: number,
  ): Promise<Result> {
    // #41 Half A + 4xx/5xx: a challenge interstitial OR an error page is returned raw, not summarized.
    if (base.challengeProvider || request.requestedOutput === "raw" || Number(base.code) >= 400) {
      base.output = "raw";
      stampTotals(base, elapsed(startMs, this.clock.nowMs()), fetchMs);
      return base;
    }

    if (!this.transformer) {
      base.output = "raw";
      base.transform = { provider: "none", reason: "unconfigured" };
      base.timings.transformMs = 0;
      // A Tier-2 result is a structured roster (contentType application/json); a failed/absent
      // summary must NOT byte-slice it mid-object. Return the bounded roster intact (output raw).
      if (base.tier !== 2) base.result = fallbackExcerpt(base.result);
      stampTotals(base, elapsed(startMs, this.clock.nowMs()), fetchMs);
      return base;
    }

    const transformStartMs = this.clock.nowMs();
    let transformed: TransformResult;
    let transformMs = 0;
    try {
      const scanContent = transformContent(base);
      transformed = await this.transformer.transform({
        mode: request.requestedOutput === "extract" ? "extract" : "summarize",
        output: request.requestedOutput,
        content: stripAdTrackerUrlsForLlm(scanContent, base),
        scanContent,
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
      base.transform = { provider: "none", reason: "failed", latencyMs: transformMs, ...(error instanceof TransformError && error.costUsd ? { costUsd: error.costUsd } : {}) };
      base.timings.transformMs = transformMs;
      base.errors.push({ code: transformErrorCode(error), message: errorMessage(error, "Transform failed") });
      // A Tier-2 result is a structured roster (contentType application/json); a failed/absent
      // summary must NOT byte-slice it mid-object. Return the bounded roster intact (output raw).
      if (base.tier !== 2) base.result = fallbackExcerpt(base.result);
      stampTotals(base, elapsed(startMs, this.clock.nowMs()), fetchMs);
      return base;
    }
    const originalResult = base.result; // preserve the resolved content (a Tier-2 roster) before the rewrite below
    base.result = transformed.result;
    base.output = transformed.info.provider === "none" ? "raw" : request.requestedOutput;
    base.transform = transformed.info;
    // (#82) A successful model fallback is SILENT in the user-facing receipt — no warning, so
    // status stays `pass` and the caller is not told a model failed. The failed-primary list rides
    // on `transform.fallbackFrom`, visible via `debug:true` and the audit log (transformFallbackFrom)
    // for the operator. An all-models-fail still surfaces honestly via the catch above
    // (provider:"none", reason:"failed").
    // No summary was produced. For a Tier-2 roster, restore the parseable JSON roster (transformed.result
    // is the preambled LLM input, not valid JSON); for pages, bound the fallback to a token-safe excerpt.
    if (transformed.info.provider === "none") {
      base.result = base.tier === 2 ? originalResult : fallbackExcerpt(base.result);
    }
    // Non-fatal advisories (#125): extract schema mismatch + truncation (cut off at the output cap after escalation).
    if (transformed.info.schemaIssue) {
      base.errors.push({ code: "extract_schema_invalid", message: transformed.info.schemaIssue });
    }
    if (transformed.info.truncated) {
      base.errors.push({ code: "transform_truncated", message: "Summary truncated at the output-token ceiling after escalation — use output: raw for the full content." });
    }
    base.timings.transformMs = transformMs;
    stampTotals(base, elapsed(startMs, this.clock.nowMs()), fetchMs);
    return base;
  }
}

export function createCaptatumUseCase(deps: CaptatumDeps): CaptatumUseCase {
  return new CaptatumUseCase(deps);
}

function rejectResult(
  request: NormalizedCaptatumInput,
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
    // Preserve the redirect chain followed before the reject (e.g. a 302 to a host that then
    // timed out) so the bulk orchestrator counts redirect-funnel victims on failed hops too.
    redirects: rejected.redirects ?? [],
    errors: [{ code: rejected.code, message: rejected.message }],
    ...(fetchedAt !== undefined ? { fetchedAt } : {}),
  };
}

import { STATUS_CODES } from "node:http";
import type { FetcherPort, FetcherResult, RejectResult } from "../ports/fetcher.ts";
import type { ClockPort } from "../ports/clock.ts";
import type { RenderPort } from "../ports/renderer.ts";
import type { TransformPort, TransformResult } from "../ports/transformer.ts";
import type { Platform } from "../../domain/platform.ts";
import type { AttemptTrace, Result, TransformInfo } from "../../domain/result.ts";
import type { Output, Tier } from "../../domain/tier.ts";
import {
  extractTier1FromFetchResult,
  type HtmlExtractor,
} from "./tier1-extract.ts";
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
    let fetched: FetcherResult | RejectResult;
    try {
      fetched = await this.fetcher.fetchGuarded(request.url, {
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
    stampTotals(base, elapsed(startMs, this.clock.nowMs()), fetchMs);
    applyRenderGate(base, request, this.renderer);
    return await this.applyOutputMode(base, request, startMs, fetchMs);
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
      base.transform = unconfiguredTransform();
      base.timings.transformMs = 0;
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
        content: base.result,
        prompt: request.prompt,
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
      base.errors.push({ code: "transform_failed", message: errorMessage(error, "Transform failed") });
      stampTotals(base, elapsed(startMs, this.clock.nowMs()), fetchMs);
      return base;
    }
    base.result = transformed.result;
    base.output = request.requestedOutput;
    base.transform = transformed.info;
    base.timings.transformMs = transformMs;
    stampTotals(base, elapsed(startMs, this.clock.nowMs()), fetchMs);
    return base;
  }
}

export function createSmartFetchUseCase(deps: SmartFetchDeps): SmartFetchUseCase {
  return new SmartFetchUseCase(deps);
}

function applyRenderGate(
  result: Result,
  request: NormalizedSmartFetchInput,
  renderer?: RenderPort,
): void {
  if (!result.jsRequired) return;

  if (!request.allowRender) {
    result.tier = "render-blocked";
    result.resolvedVia = "render-blocked";
    result.attempts.push(renderAttempt("render-blocked", "allowRender=false"));
    return;
  }

  const reason = renderer ? "render implementation pending" : "render port unconfigured";
  result.tier = "render-unavailable";
  result.resolvedVia = "render-unavailable";
  result.attempts.push(renderAttempt("render-unavailable", reason));
  result.errors.push({
    code: "render_unavailable",
    message: "Tier-3 render is not configured",
  });
}

function renderAttempt(tier: Tier, reason: string): AttemptTrace {
  return {
    step: 2,
    tier,
    outcome: "block",
    durationMs: 0,
    reason,
  };
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
    fetchedAt,
  };
}

function stampTotals(result: Result, totalMs: number, fetchMs: number): void {
  result.durationMs = totalMs;
  result.timings.totalMs = totalMs;
  result.timings.fetchMs = fetchMs;
  result.codeText = result.code === 0 ? result.codeText : STATUS_CODES[result.code] ?? "";
}

function unconfiguredTransform(): TransformInfo {
  return {
    provider: "none",
    reason: "unconfigured",
  };
}

function unexpectedReject(error: unknown): RejectResult {
  return {
    rejected: true,
    code: "network_error",
    message: errorMessage(error, "Fetch failed before a safe response was available"),
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message
    ? error.message
    : fallback;
}

function elapsed(startMs: number, endMs: number): number {
  return Math.max(0, Math.round(endMs - startMs));
}

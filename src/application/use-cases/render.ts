import type { ClockPort } from "../ports/clock.ts";
import type { FetcherPort, RejectResult } from "../ports/fetcher.ts";
import type { RenderAction, RenderOutput, RenderPort } from "../ports/renderer.ts";
import type { AttemptTrace, Result } from "../../domain/result.ts";
import type { Tier } from "../../domain/tier.ts";
import {
  extractTier1FromFetchResult,
  type HtmlExtractor,
} from "./tier1-extract.ts";
import type { NormalizedSmartFetchInput } from "./smart-fetch-input.ts";

export interface MaybeRenderInput {
  result: Result;
  request: NormalizedSmartFetchInput;
  renderer?: RenderPort;
  fetcher: FetcherPort;
  extractHtml: HtmlExtractor;
  clock: ClockPort;
}

export async function maybeRender(input: MaybeRenderInput): Promise<Result> {
  if (!input.result.jsRequired) return input.result;

  if (!input.request.allowRender) {
    input.result.tier = "render-blocked";
    input.result.resolvedVia = "render-blocked";
    input.result.attempts.push(renderAttempt("render-blocked", "block", 0, "allowRender=false"));
    return input.result;
  }

  if (!input.renderer) {
    return renderUnavailable(input.result, "render port unconfigured");
  }

  const startedAt = input.clock.nowMs();
  const rendered = await safeRender(input);
  const renderMs = elapsed(startedAt, input.clock.nowMs());
  const controlAttempts = actionAttempts(rendered.actions);
  input.result.timings.renderMs = renderMs;

  if (!rendered.rendered) {
    input.result.attempts.push(...controlAttempts);
    return renderRejected(input.result, rendered, renderMs);
  }

  const extracted = await extractTier1FromFetchResult({
    requestedUrl: input.request.url,
    fetchResult: rendered.fetchResult,
    extractHtml: input.extractHtml,
    durationMs: renderMs,
    fetchMs: input.result.timings.fetchMs,
    output: "raw",
    fetchedAt: input.result.fetchedAt,
  });
  return promoteRenderedResult(input.result, extracted, renderMs, controlAttempts);
}

function renderUnavailable(result: Result, reason: string): Result {
  result.tier = "render-unavailable";
  result.resolvedVia = "render-unavailable";
  result.attempts.push(renderAttempt("render-unavailable", "block", 0, reason));
  result.errors.push({
    code: "render_unavailable",
    message: "Tier-3 render is not configured",
  });
  return result;
}

async function safeRender(input: MaybeRenderInput): Promise<RenderOutput> {
  try {
    return await input.renderer!.render({
      url: input.result.finalUrl || input.request.url,
      maxBytes: input.request.maxBytes,
      timeoutMs: input.request.renderTimeoutMs,
      maxHops: input.request.maxHops,
      fetcher: input.fetcher,
    });
  } catch (error) {
    return {
      rendered: false,
      rejected: true,
      code: "render_error",
      message: errorMessage(error, "Tier-3 render failed"),
      actions: [],
    };
  }
}

function renderRejected(result: Result, rejected: RejectResult, renderMs: number): Result {
  const unavailable = rejected.code === "render_unavailable";
  result.tier = unavailable ? "render-unavailable" : "error";
  result.resolvedVia = unavailable ? "render-unavailable" : "tier3-playwright";
  result.attempts.push(renderAttempt(result.tier, "error", renderMs, rejected.code));
  result.errors.push({ code: rejected.code, message: rejected.message });
  return result;
}

function promoteRenderedResult(
  base: Result,
  rendered: Result,
  renderMs: number,
  controlAttempts: AttemptTrace[],
): Result {
  rendered.tier = 3;
  rendered.output = "raw";
  rendered.platform = { ...rendered.platform, detectedFrom: "tier3" };
  rendered.jsRequired = true;
  rendered.resolvedVia = "tier3-playwright";
  rendered.attempts = [
    ...base.attempts,
    renderAttempt(3, "ok", renderMs, "rendered", rendered.code, rendered.bytes),
    ...controlAttempts,
  ];
  rendered.errors = [...base.errors, ...rendered.errors];
  rendered.timings = {
    totalMs: base.timings.totalMs,
    fetchMs: base.timings.fetchMs,
    renderMs,
  };
  return rendered;
}

function actionAttempts(actions: RenderAction[]): AttemptTrace[] {
  return actions.map((action) => ({
    step: 3,
    tier: 3,
    outcome: "block",
    durationMs: 0,
    reason: actionReason(action),
  }));
}

function actionReason(action: RenderAction): string {
  const parts = [action.type, action.reason];
  if (action.resourceType) parts.push(action.resourceType);
  if (action.url) parts.push(action.url);
  return parts.join(":");
}

function renderAttempt(
  tier: Tier,
  outcome: AttemptTrace["outcome"],
  durationMs: number,
  reason: string,
  status?: number,
  bytes?: number,
): AttemptTrace {
  return { step: 3, tier, outcome, durationMs, reason, status, bytes };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function elapsed(startMs: number, endMs: number): number {
  return Math.max(0, Math.round(endMs - startMs));
}

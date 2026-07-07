import type { ClockPort } from "../ports/clock.ts";
import type { FetcherPort, RejectResult } from "../ports/fetcher.ts";
import type { RenderAction, RenderOutput, RenderPort } from "../ports/renderer.ts";
import type { AttemptTrace, Result } from "../../domain/result.ts";
import type { Tier } from "../../domain/tier.ts";
import {
  extractTier1FromFetchResult,
  type HtmlExtractor,
} from "./tier1-extract.ts";
import type { NormalizedCaptatumInput } from "./captatum-input.ts";

export interface MaybeRenderInput {
  result: Result;
  request: NormalizedCaptatumInput;
  renderer?: RenderPort;
  fetcher: FetcherPort;
  extractHtml: HtmlExtractor;
  clock: ClockPort;
}

export async function maybeRender(input: MaybeRenderInput): Promise<Result> {
  // The shell-gate (jsRequired) is the arbiter of whether to render — NOT
  // allowRender. SSR pages already have content (jsRequired=false) and must
  // return at Tier-1 even when allowRender=true (which clients like ChatGPT
  // send on every call). Only a true empty SPA shell (jsRequired=true) reaches
  // the allowRender gate below. Letting allowRender force a render of SSR pages
  // made every response Tier-3 with multi-second latency.
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
  // Surface the render's network egress + subresource hosts onto the Tier-1 result
  // EARLY so every downstream path (promote, render-empty, render-rejected-success)
  // carries them. egressBytes = the Tier-1 document fetch (input.result.bytes — the seed
  // already spent it to decide jsRequired) PLUS the Tier-3 render's subresource bytes
  // (codex P2: counting only the Tier-3 pass underreports by up to one initial fetch per
  // rendered seed). renderEgressHosts for the per-host union count gate (BULK-3). A true
  // render FAILURE (rendered=false) has no Tier-3 egress — correctly only the Tier-1 bytes.
  if (rendered.rendered) {
    const tier1Bytes = input.result.bytes ?? 0;
    const renderEgress = rendered.egressBytes ?? 0;
    input.result.egressBytes = tier1Bytes + renderEgress;
    if (rendered.egressHosts && rendered.egressHosts.length > 0) input.result.renderEgressHosts = rendered.egressHosts;
  }

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
  // #110: a render that yields NO extractable text AND no usable structured data produced nothing
  // — reject honestly instead of promoting an empty Tier-3 result. jsRequired already encodes "no
  // usable structured data" (the shell-gate sets jsRequired=false when it finds content-bearing
  // JSON-LD/app-state), so gating on it PRESERVES a render whose JS injected JobPosting/Product
  // JSON-LD but no visible body text (codex P2): those promote so summary/extract can consume the
  // structured data. Short-but-real renders ("Lazy Iframe App") stay jsRequired yet have non-empty
  // text, so the empty-text check keeps them. (#114 removed the unreachable render-failure advisory
  // that used the same `result.length > 100` shape — maybeRender only runs when jsRequired, which
  // implies result < 80 chars, so that branch was dead code.)
  if (extracted.jsRequired && extracted.result.trim().length === 0) {
    input.result.attempts.push(...controlAttempts);
    input.result.timings.renderMs = renderMs;
    return renderRejected(input.result, { rejected: true, code: "render_empty", message: "Render produced no content (empty shell)" }, renderMs);
  }
  const promoted = promoteRenderedResult(input.result, extracted, renderMs, controlAttempts);
  if (rendered.notice) promoted.errors.push(rendered.notice);
  return promoted;
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
  // A 4xx/5xx returned by the browser navigation already carries the Tier-1 http-error gate
  // (jsRequired:false, resolvedVia:"tier1-error", http_error warning). Don't clobber it by
  // marking the page JS-required / a successful render — only promote to tier3-playwright when
  // the render genuinely produced a page (non-error status).
  const httpError = Number(rendered.code) >= 400;
  rendered.output = "raw";
  if (!httpError) {
    // The render genuinely produced a page — promote to Tier 3.
    rendered.tier = 3;
    rendered.platform = { ...rendered.platform, detectedFrom: "tier3" };
    rendered.jsRequired = true;
    rendered.resolvedVia = "tier3-playwright";
  }
  // A 4xx/5xx keeps the Tier-1 http-error gate (tier:1, resolvedVia:"tier1-error", jsRequired:false).
  rendered.attempts = [
    ...base.attempts,
    renderAttempt(3, httpError ? "error" : "ok", renderMs, httpError ? "http-error" : "rendered", rendered.code, rendered.bytes),
    ...controlAttempts,
  ];
  rendered.errors = [...base.errors, ...rendered.errors];
  rendered.timings = {
    totalMs: base.timings.totalMs,
    fetchMs: base.timings.fetchMs,
    renderMs,
  };
  // Carry the render's network egress + subresource hosts (set on base in maybeRender)
  // onto the promoted result so the bulk orchestrator sees them (BULK-3 + BULK-5).
  if (base.egressBytes !== undefined) rendered.egressBytes = base.egressBytes;
  if (base.renderEgressHosts !== undefined) rendered.renderEgressHosts = base.renderEgressHosts;
  return rendered;
}

function actionAttempts(actions: RenderAction[]): AttemptTrace[] {
  return actions.map((action) => ({
    step: 3,
    tier: 3,
    outcome: action.outcome ?? "block",
    durationMs: 0,
    reason: actionReason(action),
  }));
}

function actionReason(action: RenderAction): string {
  const parts: string[] = [action.type];
  if (action.reason) parts.push(action.reason);
  if (action.method) parts.push(action.method);
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
  const attempt: AttemptTrace = { step: 3, tier, outcome, durationMs, reason };
  if (status !== undefined) attempt.status = status;
  if (bytes !== undefined) attempt.bytes = bytes;
  return attempt;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function elapsed(startMs: number, endMs: number): number {
  return Math.max(0, Math.round(endMs - startMs));
}

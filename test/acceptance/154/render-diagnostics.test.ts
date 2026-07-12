// FROZEN acceptance suite for #154 — renderDiagnostics on render_empty / render failures.
// Pins the SURFACED contract only: the renderDiagnostics shape, the possibleReason values per
// scenario, and the output-boundary no-raw-IP property. Drives maybeRender with a MOCK RenderPort
// returning a controlled RenderOutput (so the real conservative classifier runs), then asserts
// what the single-fetch + bulk shapers SURFACE — NEVER threshold constants or classifier-branch
// internals. Authored against docs/specs/154-render-diagnostics.md (the impl, PR B, adds the
// RenderDiagnostics type). FAILS pre-impl on the assertions (renderDiagnostics is absent), NOT on
// a type/import error. Editing this file turns CI red (process-guard freeze-hash). Spec: #154.

import assert from "node:assert/strict";
import { test } from "node:test";
import { maybeRender } from "../../../src/application/use-cases/render.ts";
import { buildStructuredContent } from "../../../src/interfaces/mcp/shape.ts";
import { buildBulkStructuredContent } from "../../../src/interfaces/mcp/bulk-shape.ts";
import { EMPTY_BULK_TOTALS } from "../../../src/domain/bulk-result.ts";
import { BULK_GUARD_DEFAULTS } from "../../../src/domain/bulk-policy.ts";
import type { RenderOutput, RenderPort } from "../../../src/application/ports/renderer.ts";
import type { FetcherPort } from "../../../src/application/ports/fetcher.ts";
import type { ClockPort } from "../../../src/application/ports/clock.ts";
import type { Result } from "../../../src/domain/result.ts";
import type { BulkResult, BulkSeedResult } from "../../../src/domain/bulk-result.ts";
import type { NormalizedCaptatumInput } from "../../../src/application/use-cases/captatum-input.ts";
import type { HtmlExtraction, HtmlExtractionInput } from "../../../src/application/use-cases/tier1-extract.ts";

// The SPEC's RenderDiagnostics shape (docs/specs/154-render-diagnostics.md "New field"). Declared
// LOCALLY so this suite compiles PRE-impl — the surfaced shaper payload is Record<string,unknown>,
// cast through this type. The impl (PR B) adds the canonical type to src/domain/result.ts.
interface RenderDiagnosticsShape {
  renderedBytes?: number;
  domTextLength?: number;
  egressBytes?: number;
  renderEgressHosts: string[];
  blockedRequests: number;
  forwardedRequests: number;
  possibleReason: "render-error" | "network-blocked" | "extraction-gap" | "empty-dom" | "unknown";
}

const SEED_URL = "https://app.test/shell";

// A Tier-1 base Result already AT the render gate (jsRequired:true). maybeRender returns early
// unless jsRequired is set, so this pre-positions the result for the render path.
function baseResult(overrides: Partial<Result> = {}): Result {
  return {
    url: SEED_URL, bytes: 800, code: 200, codeText: "OK", durationMs: 40, result: "",
    schemaVersion: 1, finalUrl: SEED_URL, redirects: [], tier: 1, output: "raw",
    platform: { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier1" },
    jsRequired: true, resolvedVia: "tier1-shell-gate",
    attempts: [{ step: 1, tier: 1, outcome: "escalate", status: 200, durationMs: 40, bytes: 800, reason: "empty-spa-shell" }],
    contentType: "text/html; charset=utf-8",
    timings: { totalMs: 40, fetchMs: 40 }, errors: [], ...overrides,
  };
}

const streamOf = (s: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(s)); c.close(); } });

// extractHtml stub: returns EMPTY text + jsRequired:true so a RenderSuccess with no extractable
// text routes to render_empty (render.ts "extracted.result.trim().length === 0"). The render-error
// path never reaches extraction. Not parsing the render — the body content is irrelevant here.
const emptyExtract = (_input: HtmlExtractionInput): HtmlExtraction => ({
  text: "", structured: {},
  shellGate: { jsRequired: true, reason: "empty-spa-shell", textLength: 0, wordCount: 0, scriptCount: 0, appRootFound: false, structuredDataFound: false },
  errors: [],
});

// A RenderSuccess as a Record — so the spec's NEW domTextLength field can be supplied pre-impl
// without an excess-property error, and cast to RenderOutput at the mock boundary. `blocked`/
// `forwarded` build the action list the surfaced counts derive from (request-blocked × blocked +
// request-forwarded-post × forwarded). Hosts are kept registrable (app.test/example.com) so the
// assertions are robust to a filter-vs-map normalization at the output boundary.
function success(o: {
  renderedBytes: number; domTextLength: number; egressBytes?: number; egressHosts?: string[];
  blocked?: number; forwarded?: number;
}): Record<string, unknown> {
  const actions: Record<string, unknown>[] = [];
  for (let i = 0; i < (o.blocked ?? 0); i++) actions.push({ type: "request-blocked", reason: "route-block" });
  for (let i = 0; i < (o.forwarded ?? 0); i++) actions.push({ type: "request-forwarded-post", outcome: "ok", method: "POST" });
  return {
    rendered: true,
    fetchResult: { status: 200, finalUrl: SEED_URL, redirects: [], bodyStream: streamOf(`<body>${"x".repeat(o.renderedBytes)}</body>`), contentType: "text/html; charset=utf-8", bytes: o.renderedBytes },
    actions, egressBytes: o.egressBytes ?? 0, egressHosts: o.egressHosts ?? [], domTextLength: o.domTextLength,
  };
}

const request: NormalizedCaptatumInput = {
  url: SEED_URL, prompt: "summarize", requestedOutput: "raw", maxBytes: 5_000_000, timeoutMs: 15_000,
  renderTimeoutMs: 20_000, maxHops: 5, allowRender: true, debug: false,
};
const fetcher: FetcherPort = { async fetchGuarded() { throw new Error("fetcher not used on the render path"); } };
const clock: ClockPort = { nowMs: () => 1_000 };

// Drive maybeRender with a controlled RenderOutput. "throw" → renderer rejects (safeRender catches
// → render_error); "unavailable" → no renderer (render_unavailable); else the mock returns the
// Record cast to RenderOutput (domTextLength rides through pre-impl as an undeclared key).
async function drive(out: Record<string, unknown> | "throw" | "unavailable"): Promise<Result> {
  const renderer: RenderPort | undefined = out === "unavailable" ? undefined : {
    render: async () => { if (out === "throw") throw new Error("boom"); return out as unknown as RenderOutput; },
  };
  return maybeRender({ result: baseResult(), request, renderer, fetcher, extractHtml: emptyExtract, clock });
}

function shaped(result: Result): Record<string, unknown> { return buildStructuredContent(result, false); }
function diagOf(result: Result): RenderDiagnosticsShape | undefined {
  return shaped(result).renderDiagnostics as RenderDiagnosticsShape | undefined;
}

// A minimal BulkResult envelope wrapping ONE seed carrying the given renderDiagnostics — pins the
// bulk shaper FORWARDS renderDiagnostics (seed field cast in; pre-impl BulkSeedResult lacks it).
function bulkWith(diagnostics: unknown): BulkResult {
  const seed = {
    url: SEED_URL, finalUrl: SEED_URL, status: "fail", tier: 1, code: 200, codeText: "OK", bytes: 60_000,
    egressBytes: 40_000, output: "raw", platform: "generic", jsRequired: true,
    resolvedVia: "tier3-playwright", redirectHosts: [], result: "", content: "",
    warnings: [], errors: [{ code: "render_empty", message: "Render produced no content" }],
    renderDiagnostics: diagnostics,
  } as unknown as BulkSeedResult;
  return {
    schemaVersion: 1, kind: "bulk", bulkId: "b154", ok: false, status: "fail", count: 1, passed: 0,
    failed: 1, truncated: 0, deduped: 0, totals: { ...EMPTY_BULK_TOTALS }, guard: BULK_GUARD_DEFAULTS,
    capBreaches: [], clamp: { inputUrls: 1, afterDedupe: 1, afterPerHostCap: 1, processed: 1, perHostTruncated: [], totalClampedTo: null },
    fenceToken: "fencefence", results: [seed], failures: [], warnings: [], errors: [],
  };
}

// C1 — render_empty surfaces renderDiagnostics (single + bulk). Large DOM + high domTextLength +
// zero extracted text → extraction-gap, with renderedBytes/domTextLength/Tier-3 egressBytes/counts.
test("C1: render_empty (large DOM, high domTextLength) surfaces renderDiagnostics extraction-gap, single + bulk", async () => {
  const result = await drive(success({ renderedBytes: 60_000, domTextLength: 8_000, egressBytes: 40_000, egressHosts: ["app.test"], blocked: 2, forwarded: 1 }));
  const d = diagOf(result);
  assert.ok(d, "renderDiagnostics surfaced on render_empty");
  assert.equal(d!.possibleReason, "extraction-gap");
  assert.equal(d!.renderedBytes, 60_000);
  assert.equal(d!.domTextLength, 8_000);
  assert.equal(d!.egressBytes, 40_000, "Tier-3 subresource egress, not tier1+render");
  assert.equal(d!.blockedRequests, 2, "request-blocked counts into blockedRequests");
  assert.equal(d!.forwardedRequests, 1, "request-forwarded-post counts into forwardedRequests");
  // One render outcome surfaces through BOTH shapes (single-fetch above; the bulk row below).
  const domain = (result as { renderDiagnostics?: RenderDiagnosticsShape }).renderDiagnostics;
  const row = (buildBulkStructuredContent(bulkWith(domain)).results as Array<Record<string, unknown>>)[0];
  assert.equal((row.renderDiagnostics as RenderDiagnosticsShape | undefined)?.possibleReason, "extraction-gap", "bulk row forwards renderDiagnostics");
});

// C2 — the domTextLength split (the issue's named win): large DOM ALONE is not extraction-gap.
// large+high → extraction-gap; large+low → unknown (the DOM has no text the extractor dropped);
// small+low → empty-dom. Unambiguous extremes so the assertion is robust to threshold calibration.
test("C2: domTextLength splits extraction-gap from empty-dom (large DOM + low text is NOT extraction-gap)", async () => {
  const gap = diagOf(await drive(success({ renderedBytes: 60_000, domTextLength: 8_000, egressBytes: 40_000, egressHosts: ["app.test"] })));
  assert.equal(gap?.possibleReason, "extraction-gap", "large DOM + HIGH text → extraction-gap");
  const unknownCase = diagOf(await drive(success({ renderedBytes: 60_000, domTextLength: 3, egressBytes: 40_000, egressHosts: ["app.test"] })));
  assert.equal(unknownCase?.possibleReason, "unknown", "large DOM + LOW text → unknown (no text was dropped)");
  const empty = diagOf(await drive(success({ renderedBytes: 40, domTextLength: 2, egressBytes: 40_000, egressHosts: ["app.test"] })));
  assert.equal(empty?.possibleReason, "empty-dom", "small DOM + low text → empty-dom");
});

// C3 — network-blocked: DOM present BUT Tier-3 egressBytes === 0 AND no egress hosts. Pins the
// BLOCKER Tier-3-egress fix (Result.egressBytes is tier1+render, never 0 — the classifier must
// read the Tier-3 subresource value, which is 0 here).
test("C3: DOM present + Tier-3 egressBytes === 0 + no hosts → network-blocked", async () => {
  const d = diagOf(await drive(success({ renderedBytes: 60_000, domTextLength: 8_000, egressBytes: 0, egressHosts: [] })));
  assert.equal(d?.possibleReason, "network-blocked");
  assert.equal(d?.egressBytes, 0, "the Tier-3 subresource egress is surfaced as 0");
});

// C4 — render-error: a renderer throw OR rendered:false → possibleReason render-error, with
// renderedBytes/domTextLength ABSENT (no DOM / no page was produced).
test("C4: renderer throw or rendered:false → possibleReason render-error; renderedBytes/domTextLength absent", async () => {
  const threw = diagOf(await drive("throw"));
  assert.equal(threw?.possibleReason, "render-error");
  assert.equal(threw?.renderedBytes, undefined, "no DOM produced → renderedBytes absent");
  assert.equal(threw?.domTextLength, undefined, "no page → domTextLength absent");
  const failed = diagOf(await drive({ rendered: false, rejected: true, actions: [], code: "render_timeout", message: "render timed out" }));
  assert.equal(failed?.possibleReason, "render-error");
});

// C5 — unknown is the conservative catch-all: the markup-heavy-but-text-light challenge/cookie-wall
// case lands here, NEVER a confident bot-wall label (bot-wall is deliberately not a possibleReason).
test("C5: ambiguous markup-heavy-low-text challenge case → unknown (never a confident guess)", async () => {
  const d = diagOf(await drive(success({ renderedBytes: 60_000, domTextLength: 3, egressBytes: 40_000, egressHosts: ["app.test"] })));
  assert.equal(d?.possibleReason, "unknown");
});

// C6 — net-new surfacing in single-fetch: renderEgressHosts (net-new, inside renderDiagnostics) +
// top-level egressBytes (parity with bulk, which has it on every row) both surface on the failure path.
test("C6: single-fetch surfaces net-new renderEgressHosts + egressBytes parity on the render-failure path", async () => {
  const sc = shaped(await drive(success({ renderedBytes: 60_000, domTextLength: 8_000, egressBytes: 40_000, egressHosts: ["app.test", "example.com"] })));
  const d = sc.renderDiagnostics as RenderDiagnosticsShape | undefined;
  assert.deepEqual(d?.renderEgressHosts, ["app.test", "example.com"], "net-new renderEgressHosts surfaced inside renderDiagnostics");
  assert.equal(sc.egressBytes, 800 + 40_000, "top-level egressBytes parity with bulk (tier1 doc + render egress)");
});

// C7 — absent when no render ran: Tier-1 success (jsRequired false → maybeRender returns early) and
// render_unavailable (no renderer configured → no actions/DOM) carry NO renderDiagnostics. (This
// criterion holds trivially pre-impl; it guards the impl against over-populating these paths.)
test("C7: no renderDiagnostics when no render ran — Tier-1 success + render_unavailable", async () => {
  const tier1 = shaped(baseResult({ jsRequired: false, resolvedVia: "tier1-meta", result: "real page content" }));
  assert.equal(tier1.renderDiagnostics, undefined, "Tier-1 success has no renderDiagnostics");
  const unavailable = shaped(await drive("unavailable"));
  assert.equal(unavailable.renderDiagnostics, undefined, "render_unavailable has no renderDiagnostics");
});

// C8 — security pin: a PUBLIC IP-literal subresource (the only IP kind that survives the SSRF guard
// — private/loopback are blocked pre-egress) surfaces as the [ip-literal] sentinel, NEVER the raw
// IP. Pins the output-boundary registrable-domain filter on renderEgressHosts (the BLOCKER IP fix).
test("C8: a public IP-literal subresource surfaces as [ip-literal], NEVER the raw IP", async () => {
  const sc = shaped(await drive(success({ renderedBytes: 60_000, domTextLength: 8_000, egressBytes: 40_000, egressHosts: ["app.test", "93.184.216.34"] })));
  const hosts = (sc.renderDiagnostics as RenderDiagnosticsShape | undefined)?.renderEgressHosts;
  assert.ok(Array.isArray(hosts) && hosts.length === 2, "the host COUNT is preserved (2 in → 2 out)");
  assert.ok(hosts!.includes("[ip-literal]"), "the IP-literal subresource is redacted to the [ip-literal] sentinel");
  assert.ok(!JSON.stringify(sc).includes("93.184.216.34"), "the raw public IP never reaches the surfaced receipt");
});

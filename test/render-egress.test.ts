import assert from "node:assert/strict";
import { test } from "node:test";
import { RenderEgressHosts } from "../src/infrastructure/render/render-egress.ts";
import { maybeRender } from "../src/application/use-cases/render.ts";
import { extractHtml } from "../src/infrastructure/extract/index.ts";
import type { ClockPort } from "../src/application/ports/clock.ts";
import type { FetcherPort } from "../src/application/ports/fetcher.ts";
import type { RenderPort, RenderOutput } from "../src/application/ports/renderer.ts";
import type { Result } from "../src/domain/result.ts";

const clock: ClockPort = { nowMs: () => 1000 };
const noopFetcher: FetcherPort = { async fetchGuarded() { return { rejected: true, code: "x", message: "x" }; } };

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
}

test("RenderEgressHosts.noteFulfilled: records the requested URL + every redirect hop + the final URL (codex P2)", () => {
  const h = new RenderEgressHosts();
  // A subresource requested at cdn-a, 302→tracker, 302→victim.test, final victim.test/x.
  h.noteFulfilled("https://cdn-a.test/script.js", [
    { url: "https://tracker.test/r", status: 302 },
    { url: "https://victim.test/landing", status: 302 },
  ], "https://victim.test/x");
  const hosts = new Set(h.get());
  assert.ok(hosts.has("cdn-a.test"), "requested host recorded");
  assert.ok(hosts.has("tracker.test"), "intermediate redirect host recorded");
  assert.ok(hosts.has("victim.test"), "final redirect host recorded — a render-path redirect funnel cannot evade the per-host cap");
});

test("maybeRender: egressBytes includes the Tier-1 fetch bytes + the Tier-3 render egress (codex P2)", async () => {
  // The seed already spent the Tier-1 fetch (bytes=1000) to decide jsRequired; the render then
  // egresses 5000 (subresources). result.egressBytes must be 6000, not just the 5000 Tier-3 pass.
  const base: Result = {
    url: "https://a.test/x", bytes: 1000, code: 200, codeText: "OK", durationMs: 10,
    result: "", schemaVersion: 1, finalUrl: "https://a.test/x", redirects: [], tier: 1, output: "raw",
    platform: { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier1" },
    jsRequired: true, resolvedVia: "tier1-shell-gate", attempts: [], contentType: "text/html",
    timings: { totalMs: 10, fetchMs: 10 }, errors: [],
  };
  const renderer: RenderPort = {
    async render(): Promise<RenderOutput> {
      return {
        rendered: true,
        fetchResult: {
          status: 200, finalUrl: "https://a.test/x", redirects: [],
          bodyStream: streamOf("<html><head><title>R</title></head><body><article><h1>R</h1><p>rendered content here is long enough</p></article></body></html>"),
          contentType: "text/html; charset=utf-8", bytes: 4000,
        },
        actions: [],
        egressBytes: 5000,
        egressHosts: ["cdn.test"],
      };
    },
  };
  const out = await maybeRender({
    result: base,
    request: { url: "https://a.test/x", allowRender: true, maxBytes: 1_000_000, renderTimeoutMs: 5000, maxHops: 3, timeoutMs: 5000 } as never,
    renderer,
    fetcher: noopFetcher,
    extractHtml,
    clock,
  });
  assert.equal(out.tier, 3, "the render promoted");
  assert.equal(out.egressBytes, 6000, "egressBytes = Tier-1 fetch (1000) + Tier-3 render (5000)");
  assert.equal(out.bytes, 4000, "bytes stays the rendered DOM size");
});

test("maybeRender: a FAILED render still surfaces its partial Tier-3 egress (codex R2 P2)", async () => {
  // A render that times out AFTER fulfilling some subresources returns a RenderFailure carrying
  // the partial egress. The result must count Tier-1 + the partial Tier-3 egress + the hosts, not
  // fall back to only the Tier-1 fetch (which would underreport an allowRender:true shell bulk).
  const base: Result = {
    url: "https://a.test/x", bytes: 1000, code: 200, codeText: "OK", durationMs: 10,
    result: "", schemaVersion: 1, finalUrl: "https://a.test/x", redirects: [], tier: 1, output: "raw",
    platform: { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier1" },
    jsRequired: true, resolvedVia: "tier1-shell-gate", attempts: [], contentType: "text/html",
    timings: { totalMs: 10, fetchMs: 10 }, errors: [],
  };
  const renderer: RenderPort = {
    async render(): Promise<RenderOutput> {
      return { rendered: false, rejected: true, code: "timeout", message: "render timed out", actions: [], egressBytes: 3000, egressHosts: ["victim.test"] };
    },
  };
  const out = await maybeRender({
    result: base,
    request: { url: "https://a.test/x", allowRender: true, maxBytes: 1_000_000, renderTimeoutMs: 5000, maxHops: 3, timeoutMs: 5000 } as never,
    renderer,
    fetcher: noopFetcher,
    extractHtml,
    clock,
  });
  assert.equal(out.egressBytes, 4000, "egressBytes = Tier-1 (1000) + partial Tier-3 (3000) even on a failed render");
  assert.ok(out.renderEgressHosts?.includes("victim.test"), "partial render hosts surfaced on failure");
});

test("maybeRender: threads the bulk-wall signal to the renderer (codex R4 P2 — abandoned render is cancelable)", async () => {
  // The wall signal MUST reach renderer.render so an abandoned render (wall fired mid-render) can be
  // CANCELED (page close), not just un-awaited — otherwise it keeps a browser slot + egresses post-bulk.
  const ac = new AbortController();
  let received: AbortSignal | undefined;
  const base: Result = {
    url: "https://a.test/x", bytes: 100, code: 200, codeText: "OK", durationMs: 5, result: "",
    schemaVersion: 1, finalUrl: "https://a.test/x", redirects: [], tier: 1, output: "raw",
    platform: { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier1" },
    jsRequired: true, resolvedVia: "tier1-shell-gate", attempts: [], contentType: "text/html",
    timings: { totalMs: 5, fetchMs: 5 }, errors: [],
  };
  const renderer: RenderPort = {
    async render(input): Promise<RenderOutput> {
      received = input.signal;
      return { rendered: false, rejected: true, code: "render_unavailable", message: "x", actions: [] };
    },
  };
  await maybeRender({
    result: base,
    request: { url: "https://a.test/x", allowRender: true, maxBytes: 1_000_000, renderTimeoutMs: 5000, maxHops: 3, timeoutMs: 5000 } as never,
    renderer, fetcher: noopFetcher, extractHtml, clock, signal: ac.signal,
  });
  assert.equal(received, ac.signal, "the wall signal is threaded into renderer.render");
});

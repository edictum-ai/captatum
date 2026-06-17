/**
 * smart-fetch integration suite.
 *  - SSRF / provenance: always, no network (guard rejects pre-connect).
 *  - Feature probes: gated on LIVE=1 (real network). Transform-summary needs
 *    OPENROUTER_API_KEY; render needs Chromium.
 *  Offline:  corepack pnpm test:integration
 *  Live:     LIVE=1 [OPENROUTER_API_KEY=...] corepack pnpm test:integration
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildUseCase,
  run,
  webfetchBaseline,
  searchable,
  assertProvenance,
  isLive,
  hasOpenRouterKey,
} from "./harness.ts";

const L = isLive();
const live = (name: string, fn: () => Promise<void>): void => {
  test(name, { skip: !L }, fn);
};

const ASHBY_JOB = "https://jobs.ashbyhq.com/langfuse/1bc2e248-89e7-41d7-b32f-08e9320eb5d0";

describe("SSRF guard — blocks private/internal targets (always, no network)", () => {
  for (const u of [
    "http://127.0.0.1/",
    "http://localhost/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::ffff:127.0.0.1]/",
    "http://10.0.0.5/",
  ]) {
    test(`blocks ${u}`, async () => {
      const r = await run(u);
      assert.equal(r.tier, "error");
      assert.equal(r.codeText, "FETCH_REJECTED");
      assert.ok(r.errors.length > 0);
    });
  }
  test("rejects non-http schemes at input validation", async () => {
    await assert.rejects(() => run("file:///etc/passwd"));
    await assert.rejects(() => run("gopher://x"));
  });
});

describe("provenance shape (always)", () => {
  test("a rejected fetch still returns a full contract-shaped Result", async () => {
    const r = await run("http://127.0.0.1/");
    assert.equal(r.code, 0);
    assert.equal(r.resolvedVia, "guarded-fetch");
    assertProvenance(r);
  });
});

describe("Tier-1 — static page + raw-HTML extraction (live)", () => {
  live("edictum.ai: real content, jsRequired=false, provenance complete", async () => {
    const r = await run("https://edictum.ai", { output: "raw" });
    assert.equal(r.jsRequired, false);
    assert.ok(r.bytes > 100);
    assert.ok(r.result.length > 50);
    assertProvenance(r);
  });
  live("Ashby SSR page yields the full job (the WebFetch-failure case)", async () => {
    const r = await run(ASHBY_JOB, { output: "raw", timeoutMs: 30000 });
    assert.match(searchable(r), /Senior Cloud Infrastructure Engineer/i);
    assertProvenance(r);
  });
});

describe("Tier-2 — known-platform adapter", () => {
  test("Ashby board → ashby adapter", {
    skip: "Tier-2 platform adapters are deferred — not wired into the v1 orchestrator (no src/infrastructure/<platform>/ yet).",
  }, () => {});
  live("Ashby board root resolves via Tier-1 generic (adapter deferred)", async () => {
    const r = await run("https://jobs.ashbyhq.com/langfuse", { output: "raw", timeoutMs: 30000 });
    assertProvenance(r);
  });
});

describe("Tier-3 — JS render (live + Chromium)", () => {
  live("renderer loads a real page in Chromium (rendered true)", async () => {
    const { PlaywrightRenderer } = await import("../../src/infrastructure/render/index.ts");
    const { createWreqGuardedFetcher } = await import("../../src/infrastructure/wreq/requester.ts");
    const out = await new PlaywrightRenderer().render({
      url: "https://edictum.ai",
      maxBytes: 5 * 1024 * 1024,
      timeoutMs: 40_000,
      maxHops: 5,
      fetcher: createWreqGuardedFetcher(),
    });
    assert.equal(out.rendered, true, `render did not succeed: ${out.rendered === false ? out.code : ""}`);
    assert.ok(out.fetchResult.bytes > 100, "rendered page has content");
  });
});

describe("Transform — default summary + raw fallback (live)", () => {
  test("no transformer configured → output degrades to raw (provider none)", { skip: !L }, async () => {
    const uc = await buildUseCase({ withTransformer: false });
    const r = await uc.execute({ url: "https://edictum.ai", output: "summary" });
    assert.equal(r.output, "raw");
    assert.equal(r.transform?.provider, "none");
  });
  test("summary via OpenRouter when key present (public page not over-flagged)", {
    skip: !L || !hasOpenRouterKey(),
  }, async () => {
    const r = await run("https://edictum.ai", { output: "summary", prompt: "What is this site about in one sentence?" });
    assert.notEqual(r.transform?.provider, "none", `provider=none reason=${r.transform?.reason}`);
    assert.ok((r.result?.length ?? 0) > 0, "summary produced");
    assertProvenance(r);
  });
});

describe("Baseline vs WebFetch — thesis proof (live)", () => {
  live("script-stripped baseline LOSES the Ashby description; smart-fetch keeps it", async () => {
    const baseline = await webfetchBaseline(ASHBY_JOB);
    const sf = await run(ASHBY_JOB, { output: "raw", timeoutMs: 30000 });
    assert.ok(
      searchable(sf).length > baseline.length + 1000,
      `smart-fetch should retain the JSON-LD body the baseline strips (sf=${searchable(sf).length}, base=${baseline.length})`,
    );
  });
});

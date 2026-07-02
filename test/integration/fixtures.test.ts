/**
 * Fixture integration suite — deterministic, self-hosted test pages that exercise
 * captatum's full fetch → render → extract pipeline against KNOWN content patterns.
 *
 * Each fixture is a self-contained HTML file (in ./fixtures/) demonstrating a
 * specific web-page pattern. The test renders it via the real Playwright engine
 * and ASSERTS THE EXPECTED CONTENT STRINGS ARE PRESENT in the extraction — not
 * just "non-empty" or "tier=3", but the actual words that prove the content was
 * captured. This catches the class of bug where a render succeeds (tier=3, 200,
 * 145KB) but the extracted text is empty or missing sections (the cerebralvalley
 * regression).
 *
 * Auto-skips when Chromium is unavailable. Run:
 *   PLAYWRIGHT_BROWSERS_PATH=$HOME/Library/Caches/ms-playwright node --test test/integration/fixtures.test.ts
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFixtureServer, type FixtureServer } from "./fixtures/server.ts";
import { createCaptatumUseCase } from "../../src/application/use-cases/captatum.ts";
import { extractHtml } from "../../src/infrastructure/extract/index.ts";
import { PlaywrightRenderer } from "../../src/infrastructure/render/index.ts";
import type { CaptatumUseCase } from "../../src/application/use-cases/captatum.ts";
import type { FetcherPort, FetcherResult, RejectResult, FetcherOptions } from "../../src/application/ports/fetcher.ts";

/** Stub fetcher that allows localhost (bypasses the SSRF guard — fixture tests only). */
const stubFetcher: FetcherPort = {
  async fetchGuarded(url: string, opts: FetcherOptions): Promise<FetcherResult | RejectResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      // captatum auto-upgrades http→https; the fixture server is http-only, so downgrade for localhost.
      const fetchUrl = url.replace(/^https:\/\/(127\.0\.0\.1|localhost)/, "http://$1");
      const res = await fetch(fetchUrl, { signal: controller.signal, redirect: "follow" });
      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        status: res.status,
        finalUrl: res.url || url,
        redirects: [],
        bodyStream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }),
        contentType: res.headers.get("content-type") || "text/html; charset=utf-8",
        bytes: bytes.byteLength,
      };
    } catch (e) {
      return { rejected: true, code: "network_error", message: `fixture fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      clearTimeout(timer);
    }
  },
};

// --- Chromium availability probe ---
let chromiumReady = false;
try {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  await browser.close();
  chromiumReady = true;
} catch {
  chromiumReady = false;
}
const skipReason = chromiumReady ? false : "Chromium unavailable — run `npx playwright install chromium`" as const;

// --- Shared state (top-level so it's ready before any test runs) ---
const server = await startFixtureServer();
const captatum = createCaptatumUseCase({
  fetcher: stubFetcher,
  extractHtml,
  renderer: new PlaywrightRenderer(),
  clock: { nowMs: () => Date.now() },
});

after(async () => {
  await server.close();
});

const RAW = { output: "raw" } as const;
const RENDER = { allowRender: true, timeoutMs: 30_000 } as const;

describe("Fixture integration — content-presence assertions (real Playwright)", () => {

  test("static-content: Tier-1 extracts a normal page", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/static-content`, ...RAW });
    assert.equal(r.tier, 1, "static page should resolve at Tier-1 (no render)");
    assert.match(r.result, /Static Content Page/, "title present");
    assert.match(r.result, /Item Alpha/, "list items present");
    assert.match(r.result, /Item Gamma/);
  });

  test("structured-jsonld: extracts JobPosting JSON-LD", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/structured-jsonld`, ...RAW });
    assert.match(r.result, /Senior Engineer/);
    assert.match(r.result, /Berlin/);
    assert.ok(r.structured?.jsonLd, "JSON-LD parsed into structured");
  });

  test("spa-shell: empty HTML shell → Tier-3 render produces content", { skip: skipReason, timeout: 60_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/spa-shell`, ...RAW, ...RENDER });
    assert.equal(r.tier, 3, "empty shell must escalate to render");
    assert.match(r.result, /Rendered Content/, "rendered text present");
    assert.match(r.result, /only exists after JavaScript/);
  });

  test("spa-late-load: documents the setTimeout gap (networkidle fires before 5s content)", { skip: skipReason, timeout: 60_000 }, async () => {
    // KNOWN GAP: content loaded via setTimeout (no network activity) is NOT captured because
    // networkidle fires instantly (no XHRs to wait for) and there's no flat settle.
    // The cerebralvalley.ai regression. When a flat settle / content-aware wait is added,
    // flip these assertions to assert the content IS present.
    const r = await captatum.execute({ url: `${server.url}/spa-late-load`, ...RAW, ...RENDER });
    assert.equal(r.tier, 3, "render escalates");
    assert.doesNotMatch(r.result, /Track 1: Oncology/, "content NOT captured (known gap — setTimeout has no network signal)");
  });

  test("spa-xhr-load: content fetched via XHR (2s API delay) is captured", { skip: skipReason, timeout: 60_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/spa-xhr-load`, ...RAW, ...RENDER });
    assert.equal(r.tier, 3);
    assert.match(r.result, /Oncology Drug Discovery/, "XHR-loaded tracks present");
    assert.match(r.result, /\$10,000/, "XHR-loaded prizes present");
    assert.match(r.result, /Teams of 1-4/);
  });

  test("progressive-load: documents the late-hydration gap (4s stage missed)", { skip: skipReason, timeout: 60_000 }, async () => {
    // KNOWN GAP: same as spa-late-load — the 4s stage loads via setTimeout (no network),
    // so networkidle fires before it. The 1s stage (also setTimeout) may or may not be captured.
    const r = await captatum.execute({ url: `${server.url}/progressive-load`, ...RAW, ...RENDER });
    assert.equal(r.tier, 3, "render escalates");
    assert.doesNotMatch(r.result, /Grand Prize: \$25,000/, "4s content NOT captured (known gap)");
  });

  test("tabbed-display-none: visible tab extracted; display:none tabs stripped (documented behavior)", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/tabbed-display-none`, ...RAW });
    // The visible tab (Tracks) IS extracted.
    assert.match(r.result, /AI Safety Track/, "visible tab content present");
    // The hidden tabs (display:none) are STRIPPED by the hidden-subtree stripper — this is
    // by design (prevents config blobs like the vscdn/Netflix fix). If this behavior changes
    // (e.g. display:none content is kept for rendered pages), update this assertion.
    assert.doesNotMatch(r.result, /Winner: \$50,000/, "hidden tab (Prizes) is stripped by design");
    assert.doesNotMatch(r.result, /Team size max 5/, "hidden tab (Rules) is stripped by design");
  });

  test("shadow-dom: light DOM extracted; shadow DOM is a known gap", { skip: skipReason, timeout: 60_000 }, async () => {
    // KNOWN GAP: the visible-text extractor does not pierce Shadow DOM boundaries.
    // Playwright's page.content() serializes shadow content into the HTML, but captatum's
    // hand-rolled extractor may not traverse it. When shadow piercing is added, flip this.
    const r = await captatum.execute({ url: `${server.url}/shadow-dom`, ...RAW, ...RENDER });
    assert.match(r.result, /Light DOM Header/, "light DOM always extracted");
    assert.doesNotMatch(r.result, /Shadow DOM Event Details/, "shadow DOM NOT extracted (known gap)");
  });
});

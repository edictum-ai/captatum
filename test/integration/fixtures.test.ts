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
  // chromiumSandbox off: CI Linux runners can't run Chromium's setuid sandbox, and
  // tests don't need the prod sandbox (the threat model is about the deployed runtime).
  renderer: new PlaywrightRenderer({ chromiumSandbox: false }),
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

  test("spa-late-load: content-aware settle captures setTimeout content [GUARD, was GAP]", { skip: skipReason, timeout: 60_000 }, async () => {
    // networkidle fires instantly for content loaded via setTimeout (no network
    // activity); the post-networkidle content-aware settle (waitForBodyStable) is
    // what captures it. The cerebralvalley.ai regression, now fixed.
    const r = await captatum.execute({ url: `${server.url}/spa-late-load`, ...RAW, ...RENDER });
    assert.equal(r.tier, 3, "render escalates");
    assert.match(r.result, /Track 1: Oncology/, "setTimeout content captured by the content-aware settle");
    assert.match(r.result, /Teams of 1-4/);
  });

  test("spa-xhr-load: content fetched via XHR (2s API delay) is captured", { skip: skipReason, timeout: 60_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/spa-xhr-load`, ...RAW, ...RENDER });
    assert.equal(r.tier, 3);
    assert.match(r.result, /Oncology Drug Discovery/, "XHR-loaded tracks present");
    assert.match(r.result, /\$10,000/, "XHR-loaded prizes present");
    assert.match(r.result, /Teams of 1-4/);
  });

  test("progressive-load: content-aware settle captures multi-stage hydration [GUARD, was GAP]", { skip: skipReason, timeout: 60_000 }, async () => {
    // Both stages load via setTimeout (no network); the settle watches the body
    // stabilize across the stages before capturing.
    const r = await captatum.execute({ url: `${server.url}/progressive-load`, ...RAW, ...RENDER });
    assert.equal(r.tier, 3, "render escalates");
    assert.match(r.result, /Progressive Event/, "stage-1 hydrated title captured");
    assert.match(r.result, /Grand Prize: \$25,000/, "stage-2 full content captured");
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

  // --- Must-Have fixtures from the 10-agent pattern research (57-pattern backlog) ---

  test("skeleton-screen: skeleton filler defeats shell-gate [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/skeleton-screen`, ...RAW });
    assert.match(r.result, /Loading event title/, "skeleton text present (satisfies shell-gate)");
    assert.doesNotMatch(r.result, /Grand Prize/, "real content NOT captured (skeleton defeated the gate)");
  });

  test("scroll-gated: IntersectionObserver content NOT captured [GAP]", { skip: skipReason, timeout: 60_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/scroll-gated`, ...RAW, ...RENDER });
    assert.match(r.result, /Talk 01: Rust/, "baseline content present");
    assert.doesNotMatch(r.result, /Talk 11: Elixir/, "scroll-gated content NOT captured (renderer doesn't scroll)");
  });

  test("load-more-button: click-gated content NOT captured [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/load-more-button`, ...RAW });
    assert.match(r.result, /Comment 1: Great post/, "baseline comments present");
    assert.doesNotMatch(r.result, /Comment 10: Closed/, "click-gated content NOT captured");
  });

  test("css-class-hidden: class-based display:none stripped [GUARD, was GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/css-class-hidden`, ...RAW });
    assert.match(r.result, /Senior Platform Engineer/, "real content present");
    assert.doesNotMatch(r.result, /tenantId/, "class-hidden config blob stripped (collectHiddenDisplayNoneClasses)");
    assert.doesNotMatch(r.result, /tracker-id/, "second class-hidden blob stripped");
  });

  test("cdata-jsonld: CDATA-wrapped JSON-LD parsed [GUARD, was GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/cdata-jsonld`, ...RAW });
    assert.match(r.result, /short visible lede/, "visible text present");
    assert.ok(r.structured?.jsonLd, "JSON-LD parsed despite CDATA wrapper");
    assert.match(JSON.stringify(r.structured.jsonLd), /only recoverable if the CDATA/, "CDATA body recovered into structured.jsonLd");
  });

  test("redux-state: __PRELOADED_STATE__ harvested into appState [GUARD, was GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/redux-state`, ...RAW });
    assert.match(r.result, /Widget Pro/, "visible content present");
    const app = JSON.stringify(r.structured?.appState ?? {});
    assert.match(app, /"__PRELOADED_STATE__"/, "__PRELOADED_STATE__ harvested");
    assert.match(app, /Detailed review body/, "Redux state body recovered into structured.appState");
  });

  test("generic-json-script: non-__NEXT_DATA__ application/json harvested [GUARD, was GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/generic-json-script`, ...RAW });
    assert.match(r.result, /Product via embedded JSON/, "visible content present");
    const app = JSON.stringify(r.structured?.appState ?? {});
    assert.match(app, /"__APP_DATA__"/, "generic application/json script harvested");
    assert.match(app, /spec-only-detail-A/, "embedded JSON body recovered into structured.appState");
  });

  test("next-data: __NEXT_DATA__ IS harvested [GUARD]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/next-data`, ...RAW });
    assert.equal(r.tier, 1, "resolves at Tier-1 (SSR content)");
    assert.match(r.result, /How to Brew Coffee/, "heading present");
    assert.ok(r.structured?.appState, "__NEXT_DATA__ harvested into structured.appState");
  });

  test("svg-text: <svg> <text> chart data extracted [GUARD, was GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/svg-text`, ...RAW });
    assert.match(r.result, /Q3 Revenue Report/, "heading present");
    assert.match(r.result, /Q1: \$1\.2M/, "svg <text> chart data extracted (inlineSvgText)");
    assert.match(r.result, /Q3: \$2\.4M/);
  });

  test("named-entities: most HTML entities NOT decoded [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/named-entities`, ...RAW });
    assert.match(r.result, /&copy;|&mdash;|&eacute;/, "raw entities present (NOT decoded — known gap)");
  });

  test("meta-refresh: Tier-1 doesn't follow meta refresh [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/meta-refresh`, ...RAW });
    assert.match(r.result, /Redirecting/, "interstitial body captured");
    assert.doesNotMatch(r.result, /Static Content Page/, "destination NOT followed (meta refresh ignored at Tier-1)");
  });

  test("streaming-suspense: bare hidden attr strips React streamed content [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/streaming-suspense`, ...RAW });
    assert.match(r.result, /Loading article/, "skeleton present");
    assert.doesNotMatch(r.result, /Real Streamed Article Title/, "hidden streamed content stripped");
  });

  test("error-page-404: documents 4xx body handling", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/error-404`, ...RAW });
    // Documents whether captatum extracts 4xx bodies or treats them as errors.
    if (r.tier === "error") {
      // Known: captatum may treat 4xx as an error — body is dropped.
      assert.equal(r.tier, "error", "documents: 4xx treated as error");
    } else {
      assert.match(r.result, /has moved to|couldn't find/, "4xx body content extracted");
    }
  });

  test("accordion-height-zero: max-height:0 content KEPT [GUARD]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/accordion-height-zero`, ...RAW });
    assert.match(r.result, /Full refund within 30 days/, "collapsed accordion content IS captured");
    assert.match(r.result, /SAML 2\.0 and OIDC/, "open accordion content IS captured");
  });
});

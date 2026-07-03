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
import { classifyAccess } from "../../src/application/classify.ts";
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

  test("named-entities: common named entities decoded [GUARD, was GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/named-entities`, ...RAW });
    assert.match(r.result, /© 2024 Acme Corp\. — All rights reserved\./, "copyright + em-dash decoded");
    assert.match(r.result, /Submit your résumé by Q3 … spaces limited\./, "accented + ellipsis decoded");
    assert.match(r.result, /«new» – price 10€ to 20€\./, "guillemets + en-dash + euro decoded");
    assert.match(r.result, /“quoted” & ‘single’/, "smart quotes + amp decoded");
    assert.doesNotMatch(r.result, /&copy;|&mdash;|&eacute;/, "no raw named entities remain");
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

  test("error-page-404: 4xx body is extracted, not dropped as a fatal error [GUARD]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/error-404`, ...RAW });
    // A 4xx is a completed fetch (not a guarded-fetch rejection), so the body is
    // extracted at Tier-1 — guard that this stays true (no escape hatch).
    assert.notEqual(r.tier, "error", "4xx body is extracted, not treated as a fatal error");
    assert.match(r.result, /has moved to|couldn't find/, "4xx body content extracted");
  });

  test("accordion-height-zero: max-height:0 content KEPT [GUARD]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/accordion-height-zero`, ...RAW });
    assert.match(r.result, /Full refund within 30 days/, "collapsed accordion content IS captured");
    assert.match(r.result, /SAML 2\.0 and OIDC/, "open accordion content IS captured");
  });

  // --- Must-Have GAP-documentation patterns from the 57-pattern backlog ---

  test("noscript-fallback: <noscript> content is stripped at Tier-1 [GUARD]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/noscript-fallback`, ...RAW });
    assert.match(r.result, /Real Page Content/, "real content present");
    // noscript content (meant for JS-disabled browsers) is stripped — a JS-enabled
    // agent should never see the fallback prompt as page content.
    assert.doesNotMatch(r.result, /Please enable JavaScript/);
  });

  test("pre-code-whitespace: <pre> indentation/newlines collapsed [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/pre-code-whitespace`, ...RAW });
    assert.match(r.result, /function greet\(\)/);
    assert.match(r.result, /return msg/);
    // The 4-space indent and newlines are flattened to single spaces (collapseWhitespace
    // is global) — code formatting is lost. Flip when <pre> whitespace is preserved.
    assert.doesNotMatch(r.result, /\n/, "newlines collapsed (pre formatting lost — known gap)");
    assert.doesNotMatch(r.result, /    const msg/, "4-space indent collapsed to one space");
  });

  test("login-wall-soft-gate: a 200 login form is treated as content, not gated [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/login-wall-soft-gate`, ...RAW });
    // The page is a 200 login form behind which the real content lives. Captatum has
    // no login-wall heuristic, so the form is extracted as content (access stays
    // public — never flagged gated). Flip when a login-wall detector is added.
    assert.match(r.result, /Sign in to continue/);
    assert.match(r.result, /Single Sign-On/);
    assert.equal(r.tier, 1, "login form resolves at Tier-1 as content (not gated)");
  });

  test("paywall-server-truncation: truncated article not flagged as a paywall [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/paywall-server-truncation`, ...RAW });
    assert.match(r.result, /Premium Investigation/);
    assert.match(r.result, /subscribe today/);
    // No JSON-LD isAccessibleForFree flag + no truncation heuristic → the partial
    // body is returned as content (access public, not a gated paywall).
    assert.equal(r.tier, 1, "truncated article treated as content (known gap)");
  });

  test("iframe-same-origin-document: Tier-1 does not follow an iframe src [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/iframe-same-origin-document`, ...RAW });
    assert.match(r.result, /Parent Page With Embed/);
    // The iframe's target document is NOT fetched at Tier-1 (only Tier-3 render walks
    // frames). The embedded "Static Content Page" wording is therefore absent.
    assert.doesNotMatch(r.result, /Static Content Page/, "iframe src not followed at Tier-1 (known gap)");
  });

  test("hydration-replaces-ssr-content: render returns the hydrated text, not the SSR text [behavior]", { skip: skipReason, timeout: 60_000 }, async () => {
    // The static HTML carries SSR content; client hydration REPLACES the DOM. So a
    // Tier-3 render returns different text than the Tier-1 static extract — a real
    // pattern where render ≠ Tier-1 (not a bug, but worth pinning).
    const tier1 = await captatum.execute({ url: `${server.url}/hydration-replaces-ssr`, ...RAW });
    assert.match(tier1.result, /SSR Content Visible Before Hydration/);
    const rendered = await captatum.execute({ url: `${server.url}/hydration-replaces-ssr`, ...RAW, ...RENDER });
    assert.equal(rendered.tier, 3);
    assert.match(rendered.result, /Hydrated Only Content/);
    assert.doesNotMatch(rendered.result, /SSR Content Visible/);
  });

  test("lazy-iframe-below-fold: a data-src iframe never loads (renderer doesn't scroll) [GAP]", { skip: skipReason, timeout: 60_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/lazy-iframe-below-fold`, ...RAW, ...RENDER });
    assert.equal(r.tier, 3, "empty app-root shell escalates to a real render");
    assert.match(r.result, /Lazy Iframe App/, "rendered app heading present");
    // data-src (not src) is a lazy iframe; without scrolling it into view it never
    // loads, so its target content ("Static Content Page") is absent post-render.
    assert.doesNotMatch(r.result, /Static Content Page/, "lazy data-src iframe not loaded (no scroll — known gap)");
  });

  test("cloudflare-challenge-no-markers: a marker-less challenge escapes detection [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/cloudflare-challenge-no-markers`, ...RAW });
    // The page reads like a Cloudflare interstitial, but lacks the vendor markers
    // (cdn-cgi/challenge-platform, __cf_chl, cf-mitigated, _abck, px-captcha) the
    // detector keys on → NOT flagged (access public, no challengeProvider). Assert
    // the detection metadata so this FLIPS when a marker-less heuristic is added.
    const access = classifyAccess(r);
    assert.equal(access.gated, false, "marker-less challenge not detected (known gap)");
    assert.equal(access.challengeProvider, undefined);
    assert.match(r.result, /Just a moment/, "challenge text returned as content");
  });

  test("service-worker-mediated-content: SW-blocked content unreachable [GAP]", { skip: skipReason, timeout: 60_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/service-worker-mediated`, ...RAW, ...RENDER });
    assert.equal(r.tier, 3, "empty app-root shell escalates to a real render");
    // The renderer blocks service workers, so register() rejects and the fetch the
    // SW would serve never runs — the page stays on its "Waiting" placeholder.
    assert.match(r.result, /Waiting for service worker/);
    assert.doesNotMatch(r.result, /SW-served secret content/, "SW-mediated content unreachable (SW blocked — known gap)");
  });

  // --- Should-Have GAP-documentation patterns ---

  test("closed-details-summary: a closed <details> body is over-extracted as visible [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/closed-details-summary`, ...RAW });
    assert.match(r.result, /Frequently Asked Questions/);
    assert.match(r.result, /What is your return policy/);
    // A closed <details> hides its body in the browser; captatum's extractor does not
    // model <details>, so the hidden body leaks into visible text. Flip when closed-
    // details content is suppressed.
    assert.match(r.result, /We accept returns within 30 days/, "closed-details body over-extracted (known gap)");
  });

  test("offscreen-positioned-text: offscreen/visually-hidden text is over-extracted [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/offscreen-positioned-text`, ...RAW });
    assert.match(r.result, /Visible Headline/);
    // left:-9999px / text-indent:-9999px hide text offscreen; captatum doesn't model
    // positioning, so it leaks. Flip when offscreen text is suppressed.
    assert.match(r.result, /SEO keyword stuffing hidden offscreen/, "offscreen text over-extracted (known gap)");
    assert.match(r.result, /screen-reader-only label text/);
  });

  test("malformed-jsonld-trailing: a stray trailing comma drops the whole JSON-LD [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/malformed-jsonld-trailing`, ...RAW });
    assert.match(r.result, /Visible Article Headline/);
    // The first node is valid, but a stray comma + second node makes the whole block
    // invalid JSON → the ENTIRE block is dropped (no partial recovery).
    assert.ok(!r.structured?.jsonLd, "malformed JSON-LD dropped entirely (known gap — no partial recovery)");
  });

  test("soft-404-status-200: a 200 'not found' page is treated as content [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/soft-404-status-200`, ...RAW });
    // A 200 body that says "not found" (a soft 404) is extracted as content, not
    // flagged. Flip when a soft-404 heuristic is added.
    assert.match(r.result, /Page not found/);
    assert.equal(r.tier, 1, "soft-404 treated as content (known gap)");
    assert.equal(classifyAccess(r).gated, false);
  });

  test("microdata-product: microdata (itemprop) is not harvested into structured [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/microdata-product`, ...RAW });
    assert.match(r.result, /Acme Widget Pro/, "visible product name present");
    assert.match(r.result, /\$29\.99/, "visible price present");
    // captatum parses JSON-LD/OG/meta/app-state but NOT microdata (itemscope/itemprop),
    // so the structured product fields are absent. Flip when microdata is harvested.
    assert.ok(!r.structured?.jsonLd, "microdata not converted to structured JSON-LD (known gap)");
  });

  test("canonical-points-elsewhere: the canonical URL is extracted into structured [GUARD]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/canonical-points-elsewhere`, ...RAW });
    assert.match(r.result, /Syndicated Story/);
    // The canonical (a different origin than the fetch URL) is surfaced in structured.
    assert.equal(r.structured?.canonicalUrl, "https://syndicated-origin.example.com/original-story");
  });

  test("truly-empty-page: an empty page is a render-blocked shell, no crash [behavior]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/truly-empty-page`, ...RAW });
    // An empty page is a shell the gate flags for render; without allowRender it comes
    // back render-blocked (not an error, not phantom content).
    assert.equal(r.tier, "render-blocked");
    assert.equal(r.result.trim(), "", "no content extracted from a truly empty page");
  });

  test("emoji-astral: astral-plane / multi-codepoint emoji are preserved [GUARD]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/emoji-astral`, ...RAW });
    assert.match(r.result, /🤖/);
    assert.match(r.result, /🚀/);
    assert.match(r.result, /✨/);
    assert.match(r.result, /👩‍💻/, "ZWJ (multi-codepoint) sequence preserved");
  });

  test("nuxt-data: __NUXT_DATA__ is harvested into appState [GUARD]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/nuxt-data`, ...RAW });
    assert.equal(r.tier, 1, "resolves at Tier-1 (SSR content + Nuxt state)");
    assert.match(r.result, /Best Coffee Brew/);
    const app = JSON.stringify(r.structured?.appState ?? {});
    assert.match(app, /"__NUXT_DATA__"/, "__NUXT_DATA__ harvested (the #67 broadened app-state harvest)");
  });

  test("img-alt-informational: informational <img alt> text is lost [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/img-alt-informational`, ...RAW });
    assert.match(r.result, /System Architecture/);
    assert.match(r.result, /data flow between services/);
    // The <img alt="…"> carries a meaningful description, but it's an attribute — the
    // tag stripper drops it. Flip when informational alt text is surfaced.
    assert.doesNotMatch(r.result, /API gateway routes requests/, "informational img alt lost (known gap)");
  });

  test("rdfa-structured: RDFa (property/vocab) is not harvested into structured [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/rdfa-structured`, ...RAW });
    assert.match(r.result, /RDFa Marked Meetup/);
    assert.match(r.result, /Berlin/);
    // captatum parses JSON-LD/OG/meta/app-state but NOT RDFa, so the structured Event
    // fields are absent. Flip when RDFa is harvested.
    assert.ok(!r.structured?.jsonLd, "RDFa not converted to structured JSON-LD (known gap)");
  });

  test("base-href-relative: relative URLs resolve against the fetch URL, not <base> [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/base-href-relative`, ...RAW });
    assert.match(r.result, /Page With Base Href/);
    // captatum resolves the relative canonical against the fetch URL; the <base href>
    // is not honored. Flip when <base> is consulted for relative-URL resolution.
    assert.ok(r.structured?.canonicalUrl?.includes("127.0.0.1"), "canonical resolved against the fetch URL, not <base> (known gap)");
    assert.doesNotMatch(r.structured?.canonicalUrl ?? "", /base-origin\.example\.com/);
  });

  test("object-embed-document: Tier-1 does not follow an <object data> [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/object-embed-document`, ...RAW });
    assert.match(r.result, /Page With Object Embed/);
    // Like an iframe, an <object data="…"> embed is a tag Tier-1 doesn't fetch.
    assert.doesNotMatch(r.result, /Static Content Page/, "<object data> not followed at Tier-1 (known gap)");
  });

  test("large-data-table: table cell text is preserved (structure flattened) [behavior]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/large-data-table`, ...RAW });
    assert.match(r.result, /Q3 Department Results/);
    // Cell text is preserved though the 2D row/column structure is flattened to a line.
    assert.match(r.result, /Engineering/);
    assert.match(r.result, /\$1\.2M/);
    assert.match(r.result, /Sales/);
    assert.match(r.result, /\$2\.1M/);
  });

  test("terse-error-shell: a terse 'Loading…' placeholder escalates to render, not content [GUARD]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/terse-error-shell`, ...RAW });
    // A one-word placeholder doesn't pass the shell-gate's content threshold, so the
    // page is flagged for render (render-blocked without allowRender) — it is NOT
    // mistaken for real content (contrast skeleton-screen, whose bulkier filler passes).
    assert.equal(r.tier, "render-blocked");
    assert.match(r.result, /Loading\.\.\./);
  });

  test("apollo-state-skeleton: __APOLLO_STATE__ is harvested into appState [GUARD]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/apollo-state-skeleton`, ...RAW });
    assert.match(r.result, /Apollo-Powered Product/);
    const app = JSON.stringify(r.structured?.appState ?? {});
    assert.match(app, /"__APOLLO_STATE__"/, "__APOLLO_STATE__ harvested (the #67 broadened app-state harvest)");
    assert.match(app, /Apollo Widget/);
  });

  test("js-location-redirect: a JS location redirect is not followed at Tier-1 [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/js-location-redirect`, ...RAW });
    assert.match(r.result, /Redirecting/, "interstitial placeholder captured");
    // Tier-1 doesn't run JS, so the location.href redirect is not followed.
    assert.doesNotMatch(r.result, /Static Content Page/, "JS location redirect not followed at Tier-1 (known gap)");
  });

  test("og-image-array: multiple og:image tags collapse to one [GAP]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/og-image-array`, ...RAW });
    assert.match(r.result, /Gallery Article/);
    // The OG map assigns og:image directly, so only ONE survives (last wins here);
    // the other gallery images are dropped. Flip when og:image arrays are preserved.
    assert.equal(r.structured?.og?.["og:image"], "https://example.com/img/gallery-3.jpg");
    const og = JSON.stringify(r.structured?.og ?? {});
    assert.doesNotMatch(og, /hero\.jpg|secondary\.jpg/, "other og:images collapsed away (known gap)");
  });

  test("nested-comment-threads: content inside HTML comments is stripped [GUARD]", { skip: skipReason, timeout: 30_000 }, async () => {
    const r = await captatum.execute({ url: `${server.url}/nested-comment-threads`, ...RAW });
    assert.match(r.result, /Root comment text/);
    assert.match(r.result, /Visible trailing comment/);
    // A reply thread wrapped in <!-- … --> is stripped (a browser hides it too).
    assert.doesNotMatch(r.result, /hidden reply|inside an HTML comment/, "comment-wrapped content stripped");
  });
});

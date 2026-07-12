import assert from "node:assert/strict";
import { test } from "node:test";
import type { Result } from "../src/domain/result.ts";
import { classifyContentQuality, stampContentQuality } from "../src/application/content-quality.ts";

function result(over: Partial<Result> = {}): Result {
  return {
    url: "https://example.test/", bytes: 1000, code: 200, codeText: "OK", durationMs: 50,
    result: "Real content the agent can read.", schemaVersion: 1, finalUrl: "https://example.test/", redirects: [],
    tier: 3, output: "raw",
    platform: { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier3" },
    jsRequired: true, resolvedVia: "tier3-playwright", attempts: [],
    contentType: "text/html", timings: { totalMs: 50, fetchMs: 40 }, errors: [],
    ...over,
  } as Result;
}

// ---------- #145: app_error (client-app error-boundary screen) ----------

test("classifyContentQuality: a client-app error-boundary screen → app_error (#145)", () => {
  // The Cursor repro: a short rendered result that IS the crash screen ("Something went wrong…").
  assert.equal(classifyContentQuality(result({ result: "Something went wrong A critical error occurred. Please try again." })), "app_error");
  assert.equal(classifyContentQuality(result({ result: "Application error: a client-side exception" })), "app_error");
});

test("classifyContentQuality: app_error requires a SHORT result — a real article about errors is longer (FP guard)", () => {
  const longResult = "Something went wrong in production today. " + "x".repeat(400); // > 300 chars
  assert.equal(classifyContentQuality(result({ result: longResult })), undefined);
});

test("classifyContentQuality: a normal short result is NOT app_error (no crash signature)", () => {
  assert.equal(classifyContentQuality(result({ result: "A short but legitimate page about things." })), undefined);
});

// ---------- #150: low_value (HTTP success, near-empty useful content) ----------

test("classifyContentQuality: thin large page with no content-bearing JSON-LD → low_value (#150)", () => {
  // A large page whose visible text is just "Careers" (a shell/chrome-only extraction).
  assert.equal(classifyContentQuality(result({ result: "Careers", bytes: 250_000, title: "Careers" })), "low_value");
});

test("classifyContentQuality: a JobPosting page is NOT low_value (content-bearing JSON-LD)", () => {
  assert.equal(classifyContentQuality(result({
    result: "Careers", bytes: 250_000, title: "Careers",
    structured: { jsonLd: { "@type": "JobPosting", title: "Senior Engineer" } },
  })), undefined);
});

test("classifyContentQuality: low_value requires large bytes — a small thin page is not flagged (FP guard)", () => {
  assert.equal(classifyContentQuality(result({ result: "Careers", bytes: 5_000, title: "Careers" })), undefined);
});

test("classifyContentQuality: a thin large page is low_value regardless of title language/subject — the English-only title gate is gone (#179)", () => {
  // #179: the title gate (English-only {careers,career,home,loading,untitled}) was the sole recall blocker
  // for non-English / branded titles. Post-#152 hasContentBearingJsonLd is a strict data-@type allowlist,
  // so thin text + large bytes + no content-bearing JSON-LD is the real signal. A 250k page yielding 14
  // chars IS low-value whatever the <title> says — a branded English subject title no longer exempts it:
  assert.equal(classifyContentQuality(result({ result: "Careers at Acme", bytes: 250_000, title: "Engineering at Acme" })), "low_value");
  // ...and neither does a non-English title (the StartupJobs repro: a Czech board the gate could never match):
  assert.equal(classifyContentQuality(result({ result: "Nabídky práce, které vás posunou vpřed", bytes: 250_000, title: "Nabídky práce | StartupJobs.cz" })), "low_value");
});

test("classifyContentQuality: a text-rich large page is NOT low_value regardless of title/JSON-LD (FP guard, #179)", () => {
  // With the title gate gone, the precision backstop is the text>=500 gate (LOW_VALUE_MAX_TEXT in the
  // source). A page that extracted >=500 chars of real text is never low_value — even with a generic
  // title and no JSON-LD — because the extraction got genuine content. (Empirically: linktr.ee/duolingo
  // =2244ch, behance=3571, jetbrains=4228.) The 500 boundary is the load-bearing cut.
  const realText = "A".repeat(500);
  assert.equal(classifyContentQuality(result({ result: realText, bytes: 250_000, title: "Careers" })), undefined);
  assert.equal(classifyContentQuality(result({ result: realText, bytes: 5_000 })), undefined);
});

// ---------- stamping ----------

test("stampContentQuality: app_error DEMOTES to tier:error + render_app_error (#145)", () => {
  const r = result({ result: "Something went wrong. A critical error occurred.", tier: 3 });
  stampContentQuality(r);
  assert.equal(r.contentQuality, "app_error");
  assert.equal(r.tier, "error", "demoted — a crash screen is not usable content");
  assert.ok(r.errors.some((e) => e.code === "render_app_error"));
});

test("stampContentQuality: low_value adds a NON-fatal warning (tier unchanged) (#150)", () => {
  const r = result({ result: "Careers", bytes: 250_000, title: "Careers", tier: 3 });
  stampContentQuality(r);
  assert.equal(r.contentQuality, "low_value");
  assert.equal(r.tier, 3, "NOT demoted — low_value is a warning, not a failure");
  assert.ok(r.errors.some((e) => e.code === "low_value_extraction"));
});

test("stampContentQuality: low_value message is tier-aware + cause-honest (no impossible-render prescription, #179)", () => {
  // The verdict judges TEXT-extraction quality, so the advisory must (a) not over-claim "shell or behind
  // JS" (wrong for a rendered map/video/canvas page), (b) not PRESCRIBE "re-fetch with render" (impossible
  // on the no-browser binary / contradicts an allowRender:false caller), and (c) only point at images when
  // some exist. Tier 1 → describe likely causes; tier 3 → non-textual / render-not-settled + images (if any).
  const t1 = result({ result: "Careers", bytes: 250_000, title: "Careers", tier: 1 });
  stampContentQuality(t1);
  const t1msg = t1.errors.find((e) => e.code === "low_value_extraction")!.message;
  assert.match(t1msg, /thin \(7 chars\)/);
  assert.ok(!t1msg.includes("Rendered"), "tier-1 page was not rendered — do not say Rendered");
  assert.ok(!t1msg.includes("re-fetch with render"), "tier-1 must not prescribe render (impossible on the no-browser flavor)");

  const t3 = result({ result: "Careers", bytes: 250_000, title: "Careers", tier: 3, structured: { images: ["https://x.test/a.png"] } });
  stampContentQuality(t3);
  const t3msg = t3.errors.find((e) => e.code === "low_value_extraction")!.message;
  assert.match(t3msg, /Rendered but the text extraction is thin/);
  assert.match(t3msg, /render may not have settled/);
  assert.match(t3msg, /1 image\(s\)/);
  assert.ok(!t3msg.includes("shell or behind JS"), "tier-3 must not over-claim 'shell or behind JS'");

  // A rendered thin page with NO surfaced images must not append a pointless "0 image(s)" vision clause.
  const t3noImg = result({ result: "Careers", bytes: 250_000, title: "Careers", tier: 3 });
  stampContentQuality(t3noImg);
  assert.ok(!t3noImg.errors.find((e) => e.code === "low_value_extraction")!.message.includes("image(s) surfaced"), "no vision clause when 0 images");
  assert.notEqual(t1msg, t3msg, "tier 1 and tier 3 produce distinct advisories");
});

test("stampContentQuality: a normal result is untouched (no-op)", () => {
  const r = result({ result: "A real article about captatum and trustworthy web fetching." });
  stampContentQuality(r);
  assert.equal(r.contentQuality, undefined);
  assert.equal(r.errors.length, 0);
});

test("stampContentQuality: a failed fetch (tier:error) is not content-quality-classified", () => {
  // A FETCH_REJECTED carrying "something went wrong"-ish text must not be re-classified.
  const r = result({ result: "Something went wrong", tier: "error" });
  stampContentQuality(r);
  assert.equal(r.contentQuality, undefined);
});

// ---------- tightened precision (codex/self-review FP findings) ----------

test("classifyContentQuality: a Tier-1 help doc QUOTING the phrase is NOT app_error (tier gate)", () => {
  // Error-boundary screens are a RENDERED (tier 3) phenomenon — a static help/status page is not.
  assert.equal(classifyContentQuality(result({ tier: 1, result: "If you see 'Something went wrong', click retry to reload the app." })), undefined);
});

test("classifyContentQuality: a JSON API error body is NOT app_error (tier gate excludes JSON)", () => {
  assert.equal(classifyContentQuality(result({ tier: 1, contentType: "application/json", result: '{"error":"something went wrong","request_id":"abc"}' })), undefined);
});

test("classifyContentQuality: a tier-3 page that includes but does NOT LEAD WITH the signature is NOT app_error (startsWith)", () => {
  // A crash screen's text IS the error message (leads with it); a page that merely mentions it doesn't.
  assert.equal(classifyContentQuality(result({ tier: 3, result: "Welcome to Acme. If something went wrong during signup, contact support." })), undefined);
});

test("classifyContentQuality: an Event/Recipe page is NOT low_value (content-bearing JSON-LD, not just job/product/article)", () => {
  // #150 codex: the extractor treats Event/Recipe/Course/Review/etc. as content-bearing too.
  assert.equal(classifyContentQuality(result({
    result: "Events", bytes: 250_000, title: "Home",
    structured: { jsonLd: { "@type": "Event", name: "Annual Conference", description: "A real event with details." } },
  })), undefined);
});

test("classifyContentQuality: a SoftwareApplication page is NOT low_value (shared CONTENT_TYPES, no drift)", () => {
  // #159/#152: the content-bearing predicate is the single source of truth (CONTENT_TYPES). A
  // SoftwareApplication with a description is content-bearing → not low_value. (#152 requires a
  // content field — `description`, not just `name` — so the fixture carries one.)
  assert.equal(classifyContentQuality(result({
    result: "App", bytes: 250_000, title: "Home",
    structured: { jsonLd: { "@type": "SoftwareApplication", name: "Acme App", description: "Acme App — a thing an agent can read about." } },
  })), undefined);
});

test("classifyContentQuality: a large-SPA-tiny-DOM page (egressBytes ≫ bytes) → low_value (#159 codex)", () => {
  // A rendered SPA loads >100k of JS/CSS (egressBytes) but leaves a tiny DOM (bytes). The threshold
  // must use the network size (egressBytes ?? bytes) — else the exact shell this catches slips through.
  assert.equal(classifyContentQuality(result({ result: "Careers", bytes: 5_000, egressBytes: 250_000, title: "Careers" })), "low_value");
});

test("classifyContentQuality: an anti-bot challenge is NOT content-quality-classified", () => {
  // A challenge is already gated (challengeProvider set), not "low-quality content".
  assert.equal(classifyContentQuality(result({ challengeProvider: "cloudflare", result: "Just a moment...", title: "Just a moment..." })), undefined);
});

test("classifyContentQuality: an HTTP 4xx/5xx page is NOT content-quality-classified (already a failure)", () => {
  // A large text-poor 404/500 page stays tier 1 + http_error (NOT tier:error), but it is a failed
  // fetch, not "low-quality content" — must not be stamped low_value (#159 codex).
  assert.equal(classifyContentQuality(result({ code: 404, result: "Not Found", bytes: 250_000, title: "Home" })), undefined);
  assert.equal(classifyContentQuality(result({ code: 503, result: "Service Unavailable", bytes: 250_000, title: "Home" })), undefined);
});

test("classifyContentQuality: a render-incapable tier is NOT content-quality-classified (#179 review)", () => {
  // A large JS shell that could not render — local no-browser binary (render-unavailable) or an
  // allowRender:false caller (render-blocked) — is a FAILED fetch (status:fail via !hasContent), not
  // "low-quality content". Flagging it low_value would (a) contradict the failure status, and (b) emit a
  // tier-1 advisory that prescribes an impossible re-render. The content-tier guard excludes them. This
  // REGRESSION test fails if the guard reverts to excluding only tier:"error" (render-unavailable/block
  // both reach detectLowValue on a 250k/"Loading..."/no-JSON-LD shell → low_value).
  assert.equal(classifyContentQuality(result({ result: "Loading...", bytes: 250_000, title: "App", tier: "render-unavailable" })), undefined);
  assert.equal(classifyContentQuality(result({ result: "Loading...", bytes: 250_000, title: "App", tier: "render-blocked" })), undefined);
});

test("classifyContentQuality: a tier-1 app-state page with thin DELIVERED text IS low_value (#185 codex P2 — declined)", () => {
  // codex P2 asked detectLowValue to mirror the shell-gate's app-state predicate (exempt __NEXT_DATA__/
  // __NUXT_DATA__/__PRELOADED_STATE__/etc. pages). Declined: appState is NOT surfaced in the LEAN receipt
  // (it is debug-gated), so a tier-1 app-state page with <500 visible chars still DELIVERS thin content
  // to the agent — low_value is honest. Mirroring app-state would regress the #179 repro (StartupJobs:
  // a Nuxt shell, 68 chars visible, __NUXT_DATA__ present → would silently pass again). The deeper fix
  // for such pages is shell-gate/render fidelity (#152/#154), out of scope for the content-quality layer.
  // REGRESSION: pins the intentional JSON-LD-only predicate; FAILS if a future change adds the app-state
  // exemption (these would flip from "low_value" to undefined).
  assert.equal(classifyContentQuality(result({
    result: "Dashboard", bytes: 250_000, title: "Acme Dashboard", tier: 1,
    structured: { appState: { __NEXT_DATA__: { props: { user: "alice" } } } },
  })), "low_value");
  assert.equal(classifyContentQuality(result({
    result: "Dashboard", bytes: 250_000, title: "Acme Dashboard", tier: 1,
    structured: { appState: { __NUXT_DATA__: [1, 2, 3] } },
  })), "low_value");
});

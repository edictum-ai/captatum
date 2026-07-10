// FROZEN acceptance suite for #151 — classify 429/DataDome/Imperva bot-verification
// walls as gated. Authored INDEPENDENTLY of the implementation, purely from the spec
// (docs/specs/151-antibot-bot-verification.md) + public source signatures. Asserts the
// DESIRED post-implementation agent-facing classification by driving the REAL detection
// path: computeAntiBotEvidence(status, body, headers) → stampAntibotChallenge → classifyAccess.
// These WILL FAIL against pre-#151 code (intended). Hash-frozen after authoring.
// Spec: docs/specs/151-antibot-bot-verification.md — criteria 1,1b,2,2b,3,4,5,6,6b,7,9,10.
// ReDoS-shape (8a) + 4096-cap (8b) live in redos.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAccess } from "../../../src/application/classify.ts";
import { stampAntibotChallenge } from "../../../src/application/antibot.ts";
import { computeAntiBotEvidence } from "../../../src/infrastructure/http/antibot-evidence.ts";
import { buildStructuredContent } from "../../../src/interfaces/mcp/shape.ts";
import { createCaptatumUseCase } from "../../../src/application/use-cases/captatum.ts";
import { PlatformAdapterRegistry } from "../../../src/application/ports/platform-adapter.ts";
import type {
  AntiBotEvidence,
  FetcherPort,
  FetcherResult,
} from "../../../src/application/ports/fetcher.ts";
import type { Result } from "../../../src/domain/result.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const emptyBody = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({ start(c) { c.close(); } });

/** A minimal valid Result with `code`/`contentType` set (classifyAccess reads these). */
function bareResult(code: number, contentType = "text/html; charset=utf-8"): Result {
  return {
    url: "https://x.test/", bytes: 0, code, codeText: String(code), durationMs: 0,
    result: "some real page content so hasContent() is true", schemaVersion: 1,
    finalUrl: "https://x.test/", redirects: [], tier: 1, output: "raw",
    platform: { adapterId: "generic", label: "g", detectedFrom: "tier1" },
    jsRequired: false, resolvedVia: "tier1", attempts: [], contentType,
    timings: { totalMs: 0, fetchMs: 0 }, errors: [],
  };
}

/**
 * Drive the REAL detection → classification path for a (status, body, headers) response and
 * return { base, isChallenge, access }. computeAntiBotEvidence runs the actual marker/phrase
 * regexes + the status/non-JSON gates over the body; stampAntibotChallenge + classifyAccess run
 * the real classification. Asserts are on the agent-facing `access` (gateReason/challengeProvider).
 */
function classify(status: number, body: string, headers: Record<string, string> = {}) {
  const contentType = headers["content-type"] ?? "text/html; charset=utf-8";
  const ev = computeAntiBotEvidence(headers, enc(body), status) as AntiBotEvidence & {
    hasVerificationPhrase?: boolean; hasDataDomeBody?: boolean; hasImpervaBody?: boolean;
  };
  const fetched: FetcherResult = {
    status, finalUrl: "https://x.test/", redirects: [], bodyStream: emptyBody(),
    contentType, bytes: body.length, antibot: ev,
  };
  const base = bareResult(status, contentType);
  const isChallenge = stampAntibotChallenge(base, fetched);
  return { base, isChallenge, evidence: ev, access: classifyAccess(base) };
}

// --- Criterion 1: DataDome CHALLENGE body (captcha-delivery CDN) → captcha, provider datadome ---

test("C1: a DataDome challenge body (captcha-delivery) at 403 → gateReason captcha, provider datadome", () => {
  const { access, evidence } = classify(403,
    `<html><head><script src="https://ct.captcha-delivery.com/c.js"></script></head>` +
    `<body>bb captcha</body></html>`, { server: "ddog-guard" });
  assert.equal(evidence.hasChallengeBody, true, "captcha-delivery is a challenge marker");
  assert.equal(access.gated, true);
  assert.equal(access.gateReason, "captcha");
  assert.equal(access.challengeProvider, "datadome");
});

// --- Criterion 1b: DataDome FP guard — a PASSING page carries only the SDK tag, never the CDN ---

test("C1b (FP): a 200 DataDome-protected page with only js.datadome.co/tags.js is NOT gated", () => {
  const { access, evidence } = classify(200,
    `<html><head><script src="https://js.datadome.co/tags.js" async></script>` +
    `<title>Real DataDome-protected content</title></head><body>real article body</body></html>`);
  assert.equal(evidence.hasChallengeBody, false, "the bare SDK tag is NOT a challenge marker");
  assert.equal(access.gated, false, "a passing DataDome-protected page must not be gated");
  assert.notEqual(access.gateReason, "captcha");
});

// --- Criterion 2: Imperva BLOCK body (Incapsula incident ID) → captcha, provider imperva ---

test("C2: an Imperva block body (Incapsula incident ID) at 403 → gateReason captcha, provider imperva", () => {
  const { access, evidence } = classify(403,
    `<html><body>Request unsuccessful. Incapsula incident ID: 1234567890-0` +
    `<br/>Powered By Incapsula</body></html>`);
  assert.equal(evidence.hasChallengeBody, true, "Incapsula incident ID is a challenge marker");
  assert.equal(access.gated, true);
  assert.equal(access.gateReason, "captcha");
  assert.equal(access.challengeProvider, "imperva");
});

// --- Criterion 2b: Imperva FP guard — a PASSING page carries only the inline sensor ---

test("C2b (FP): a 200 Imperva-protected page with only /_Incapsula_Resource?SWJIYLWA= is NOT gated", () => {
  const { access, evidence } = classify(200,
    `<html><head><script src="/_Incapsula_Resource?SWJIYLWA=719abc"></script></head>` +
    `<body>real Incapsula-fronted content</body></html>`);
  assert.equal(evidence.hasChallengeBody, false, "the inline SWJIYLWA sensor is NOT a challenge marker");
  assert.equal(access.gated, false, "a passing Imperva-protected page must not be gated");
  assert.notEqual(access.gateReason, "captcha");
});

// --- Criterion 3: HashiCorp 429 "verifying your browser" → bot_verification (the issue repro) ---

test("C3: a 429 'verifying your browser' interstitial → gateReason bot_verification, no provider", () => {
  const { access, base } = classify(429,
    `<html><head><title>Just a moment...</title></head>` +
    `<body>We are verifying your browser. Please wait a moment.</body></html>`);
  assert.equal(access.gated, true);
  assert.equal(access.gateReason, "bot_verification");
  assert.equal(access.challengeProvider, undefined, "vendor not attributable for a generic phrase");
  assert.equal(base.botVerification, true, "the Result carries the botVerification flag");
});

// --- Criterion 4: a 503 "checking your browser" → bot_verification ---

test("C4: a 503 'checking your browser' interstitial → gateReason bot_verification", () => {
  const { access } = classify(503,
    `<html><body>Checking your browser before accessing the site.</body></html>`);
  assert.equal(access.gated, true);
  assert.equal(access.gateReason, "bot_verification");
});

// --- Criterion 5: status-gate FP guard — the SAME phrase at 200 is NOT gated ---

test("C5 (status gate): a 200 body with 'verifying your browser' is NOT gated", () => {
  const { access, evidence } = classify(200,
    `<html><body>An article that happens to say "verifying your browser" in prose.</body></html>`);
  assert.equal(evidence.hasVerificationPhrase, false, "the status gate (429/503) suppresses the phrase at 200");
  assert.equal(access.gated, false, "a 200 page is never bot-gated on the phrase alone");
  assert.notEqual(access.gateReason, "bot_verification");
});

// --- Criterion 6: content FP guard — a 429 JSON error with no phrase/marker is http_error, not bot_verification ---

test("C6 (content FP): a 429 JSON API error (no phrase, no marker) → http_error, NOT bot_verification", () => {
  const { access } = classify(429, `{"error":"rate_limited","retry_after":30}`,
    { "content-type": "application/json" });
  assert.notEqual(access.gateReason, "bot_verification");
  assert.equal(access.gateReason, "http_error");
});

// --- Criterion 6b: JSON-gate FP guard — a 429 JSON whose message contains the phrase is NOT bot_verification ---

test("C6b (JSON gate): a 429 application/json body containing 'verifying your browser' is NOT bot_verification", () => {
  const { access, evidence } = classify(429,
    `{"error":"rate_limited","detail":"we are verifying your browser fingerprint"}`,
    { "content-type": "application/json" });
  assert.equal(evidence.hasVerificationPhrase, false, "the non-JSON gate suppresses the phrase for a JSON body");
  assert.notEqual(access.gateReason, "bot_verification");
});

// --- Criterion 7: no regression — Cloudflare/Akamai/PerimeterX still captcha with the right provider ---

test("C7 (no regression): cf-mitigated + cdn-cgi/challenge-platform → captcha, cloudflare", () => {
  const { access } = classify(403,
    `<html><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/jsch/v1"></script></html>`,
    { "cf-mitigated": "challenge", server: "cloudflare" });
  assert.equal(access.gateReason, "captcha");
  assert.equal(access.challengeProvider, "cloudflare");
});

test("C7 (no regression): Akamai _abck body → captcha, akamai", () => {
  const { access } = classify(403,
    `<html><script>window._abck || sense_data;</script></html>`, { server: "akamaighost" });
  assert.equal(access.gateReason, "captcha");
  assert.equal(access.challengeProvider, "akamai");
});

test("C7 (no regression): PerimeterX px-captcha body → captcha, perimeterx", () => {
  const { access } = classify(403,
    `<html><div id="px-captcha"></div><script src="/_px/main.js"></script></html>`,
    { server: "perimeterx" });
  assert.equal(access.gateReason, "captcha");
  assert.equal(access.challengeProvider, "perimeterx");
});

// --- Criterion 9: ordering — a 429 bot wall yields bot_verification, NOT http_error ---
//     (distinct from C6: this wall HAS the phrase. bot_verification must precede the code>=400 branch.)

test("C9 (ordering): a 429 bot-verification wall is bot_verification, NOT http_error", () => {
  const { access } = classify(429,
    `<html><body>Please wait while we are verifying your browser.</body></html>`);
  assert.equal(access.gateReason, "bot_verification");
  assert.notEqual(access.gateReason, "http_error");
});

// --- Precedence: a vendor-marker wall co-occurring with the phrase classifies as captcha (vendor wins) ---

test("Precedence: a DataDome marker + 'verifying your browser' → captcha (vendor-attributed wins)", () => {
  const { access } = classify(429,
    `<html><script src="https://ct.captcha-delivery.com/c.js"></script>` +
    `<body>We are verifying your browser.</body></html>`);
  assert.equal(access.gateReason, "captcha", "a vendor marker co-occurring with a phrase is captcha, not bot_verification");
  assert.equal(access.challengeProvider, "datadome");
});

// --- Criterion 10: raw-gate — a bot_verification result is output raw (never summarized) + not
//     double-stamped contentQuality, and gateReason flows into the lean receipt. Driven through
//     execute() (the full pipeline incl. the isChallenge short-circuit + applyOutputMode). ---

test("C10: a bot_verification result is returned output:raw and surfaced as bot_verification in the lean receipt", async () => {
  const body = enc(`<html><body>We are verifying your browser. Please wait.</body></html>`);
  const evidence: AntiBotEvidence = {
    status: 429, serverVendor: "none", hasCfMitigated: false, hasCfRay: false,
    hasChallengeCookie: false, hasChallengeBody: false,
    hasDataDomeBody: false, hasImpervaBody: false, hasVerificationPhrase: true,
  } as AntiBotEvidence;
  const fetcher: FetcherPort = {
    async fetchGuarded(): Promise<FetcherResult> {
      return {
        status: 429, finalUrl: "https://x.test/", redirects: [],
        bodyStream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(body); c.close(); } }),
        contentType: "text/html; charset=utf-8", bytes: body.byteLength, antibot: evidence,
      };
    },
  };
  const useCase = createCaptatumUseCase({
    fetcher,
    extractHtml: () => ({
      text: "verifying your browser", structured: {},
      shellGate: { jsRequired: false, reason: "content-present", textLength: 23, wordCount: 3, scriptCount: 0, appRootFound: false, structuredDataFound: false },
      errors: [],
    }),
    // A transformer is present so output:summary is normally attempted — the raw-gate must suppress it.
    transformer: { async transform() { return { result: "SHOULD NOT BE USED", info: { provider: "openrouter", model: "m" } }; } },
    adapters: new PlatformAdapterRegistry([]),
    clock: { nowMs: () => 0 },
  });
  const result = await useCase.execute({ url: "https://x.test/", output: "summary" });
  assert.equal(result.botVerification, true);
  assert.equal(result.output, "raw", "a bot_verification wall is returned raw, never summarized");
  assert.equal(result.contentQuality, undefined, "a bot wall is not double-stamped low_value/app_error");
  const lean = buildStructuredContent(result, false);
  const access = lean.access as { gateReason: string; challengeProvider?: string };
  assert.equal(access.gateReason, "bot_verification", "the lean receipt forwards bot_verification");
  assert.equal(access.challengeProvider, undefined);
});

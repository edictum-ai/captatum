import assert from "node:assert/strict";
import { test } from "node:test";
import { challengeProvider, detectAntibotBlock, stampAntibotChallenge } from "../src/application/antibot.ts";
import { computeAntiBotEvidence } from "../src/infrastructure/http/antibot-evidence.ts";
import { classifyAccess } from "../src/application/classify.ts";
import type { Result } from "../src/domain/result.ts";
import type { AntiBotEvidence, FetcherResult } from "../src/application/ports/fetcher.ts";

function bareResult(over: Partial<Result> = {}): Result {
  return {
    url: "", bytes: 0, code: 200, codeText: "", durationMs: 0, result: "",
    schemaVersion: 1, finalUrl: "", redirects: [], tier: 1, output: "raw",
    platform: { adapterId: "generic", label: "g", detectedFrom: "tier1" },
    jsRequired: false, resolvedVia: "tier1", attempts: [], contentType: "text/html",
    timings: { totalMs: 0, fetchMs: 0 }, errors: [],
    ...over,
  };
}

function result(status: number, e: Partial<AntiBotEvidence> = {}): FetcherResult {
  return {
    status,
    finalUrl: "https://x.test/",
    redirects: [],
    bodyStream: new ReadableStream({ start(c) { c.close(); } }),
    contentType: "text/html",
    bytes: 0,
    antibot: {
      status,
      serverVendor: "none",
      hasCfMitigated: false,
      hasCfRay: false,
      hasChallengeCookie: false,
      hasChallengeBody: false,
      hasDataDomeBody: false,
      hasImpervaBody: false,
      hasVerificationPhrase: false,
      ...e,
    },
  };
}

test("detectAntibotBlock: cf-mitigated header on a 403 → fires", () => {
  assert.equal(detectAntibotBlock(result(403, { hasCfMitigated: true }))?.signal, "cf-mitigated");
});

test("detectAntibotBlock: vendor challenge body (Cloudflare markers) on a 503 → fires", () => {
  assert.equal(detectAntibotBlock(result(503, { hasChallengeBody: true }))?.signal, "challenge-body");
});

test("detectAntibotBlock: a vendor challenge cookie ALONE does NOT fire (set on ordinary CF-served pages)", () => {
  // __cf_bm / datadome / _px cookies are set on non-challenge pages too, so a
  // cookie — even with cf-ray/server attribution — is not a challenge signal.
  assert.equal(detectAntibotBlock(result(429, { hasChallengeCookie: true, serverVendor: "cloudflare", hasCfRay: true })), null);
  assert.equal(detectAntibotBlock(result(403, { hasChallengeCookie: true, serverVendor: "none" })), null);
});

test("detectAntibotBlock: ordinary 403 auth wall (no vendor signals) → does NOT fire", () => {
  assert.equal(detectAntibotBlock(result(403)), null);
});

test("detectAntibotBlock: ordinary 503 service-unavailable → does NOT fire", () => {
  assert.equal(detectAntibotBlock(result(503)), null);
});

test("detectAntibotBlock: vendor signals at status 200 → FIRES (a challenge interstitial can be served at 200)", () => {
  assert.equal(detectAntibotBlock(result(200, { hasCfMitigated: true }))?.signal, "cf-mitigated");
  assert.equal(detectAntibotBlock(result(200, { hasChallengeBody: true }))?.signal, "challenge-body");
});

test("detectAntibotBlock: no antibot evidence at all → does NOT fire", () => {
  const r: FetcherResult = { status: 403, finalUrl: "https://x.test/", redirects: [], bodyStream: new ReadableStream({ start(c) { c.close(); } }), contentType: "text/html", bytes: 0 };
  assert.equal(detectAntibotBlock(r), null);
});

test("Half A: a Cloudflare-challenge fetch stamps the result gated (captcha, cloudflare)", () => {
  const fetched = result(403, { hasCfMitigated: true, serverVendor: "cloudflare" });
  const base = bareResult();
  assert.equal(stampAntibotChallenge(base, fetched), true);
  assert.equal(base.challengeProvider, "cloudflare");
  assert.ok(base.errors.some((e) => e.code === "antibot_challenge"));
  const access = classifyAccess(base);
  assert.equal(access.gated, true);
  assert.equal(access.gateReason, "captcha");
  assert.equal(access.challengeProvider, "cloudflare");
});

test("Half A: a non-challenge fetch is not stamped", () => {
  const fetched = result(403, { serverVendor: "none" }); // ordinary 403, no vendor signal
  const base = bareResult();
  assert.equal(stampAntibotChallenge(base, fetched), false);
  assert.equal(base.challengeProvider, undefined);
  assert.equal(classifyAccess(base).gated, false);
});

// --- #151: DataDome / Imperva vendor attribution + the bot_verification phrase path ---

test("#151: detectAntibotBlock returns verification-phrase for a generic phrase wall", () => {
  assert.equal(detectAntibotBlock(result(429, { hasVerificationPhrase: true }))?.signal, "verification-phrase");
  assert.equal(detectAntibotBlock(result(503, { hasVerificationPhrase: true }))?.signal, "verification-phrase");
});

test("#151: a vendor challenge-body marker co-occurring with a phrase classifies as challenge-body (vendor wins)", () => {
  // detectAntibotBlock checks hasChallengeBody BEFORE hasVerificationPhrase, so a DataDome/Imperva
  // wall that also carries a phrase is vendor-attributed (captcha), not bot_verification.
  assert.equal(
    detectAntibotBlock(result(429, { hasChallengeBody: true, hasVerificationPhrase: true }))?.signal,
    "challenge-body",
  );
});

test("#151: challengeProvider attributes datadome/imperva from the body-marker booleans", () => {
  assert.equal(challengeProvider({ status: 403, serverVendor: "none", hasCfMitigated: false, hasCfRay: false, hasChallengeCookie: false, hasChallengeBody: true, hasDataDomeBody: true, hasImpervaBody: false, hasVerificationPhrase: false }), "datadome");
  assert.equal(challengeProvider({ status: 403, serverVendor: "none", hasCfMitigated: false, hasCfRay: false, hasChallengeCookie: false, hasChallengeBody: true, hasDataDomeBody: false, hasImpervaBody: true, hasVerificationPhrase: false }), "imperva");
});

test("#151: a verification-phrase wall stamps botVerification (NOT challengeProvider) → gateReason bot_verification, not http_error", () => {
  const fetched = result(429, { hasVerificationPhrase: true }); // HashiCorp-class repro
  const base = { ...bareResult(), code: 429, codeText: "429" };
  assert.equal(stampAntibotChallenge(base, fetched), true);
  assert.equal(base.botVerification, true);
  assert.equal(base.challengeProvider, undefined, "vendor not attributable for a generic phrase");
  assert.ok(base.errors.some((e) => e.code === "antibot_challenge"));
  assert.ok(!/undefined/.test(base.errors.find((e) => e.code === "antibot_challenge")!.message), "no 'undefined' provider in the message");
  // classifyAccess: bot_verification MUST win over the code>=400 http_error branch (the 429 is ≥400).
  const access = classifyAccess(base);
  assert.equal(access.gated, true);
  assert.equal(access.gateReason, "bot_verification");
  assert.equal(access.challengeProvider, undefined);
});

test("#151: a DataDome challenge-body wall stamps challengeProvider=datadome → gateReason captcha", () => {
  const fetched = result(403, { hasChallengeBody: true, hasDataDomeBody: true });
  const base = { ...bareResult(), code: 403, codeText: "403" };
  assert.equal(stampAntibotChallenge(base, fetched), true);
  assert.equal(base.challengeProvider, "datadome");
  assert.equal(base.botVerification, undefined);
  assert.equal(classifyAccess(base).gateReason, "captcha");
});

test("#151: a verification phrase buried DEEP under a large <head> (Vercel/HashiCorp repro) still → bot_verification", () => {
  // The real wall (Vercel Security Checkpoint) is ~31KB with ~28KB of <head> JS before the phrase.
  // The status-gated phrase scans the FULL body, so a deep phrase is still caught end-to-end
  // (computeAntiBotEvidence → stampAntibotChallenge → classifyAccess). Found by the live prod check
  // on 0.15.0, missed by the shallow synthetic fixture.
  const body = new TextEncoder().encode("x".repeat(30000) + " We are verifying your browser. Please wait.");
  const ev = computeAntiBotEvidence({ "content-type": "text/html" }, body, 429);
  const fetched: FetcherResult = {
    status: 429, finalUrl: "https://x.test/", redirects: [],
    bodyStream: new ReadableStream({ start(c) { c.close(); } }),
    contentType: "text/html", bytes: body.byteLength, antibot: ev,
  };
  const base = { ...bareResult(), code: 429, codeText: "429" };
  assert.equal(stampAntibotChallenge(base, fetched), true);
  assert.equal(base.botVerification, true);
  assert.equal(classifyAccess(base).gateReason, "bot_verification");
});

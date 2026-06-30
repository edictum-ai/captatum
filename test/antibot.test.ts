import assert from "node:assert/strict";
import { test } from "node:test";
import { detectAntibotBlock, stampAntibotChallenge } from "../src/application/antibot.ts";
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

test("detectAntibotBlock: vendor cookie + vendor attribution → fires", () => {
  const r = result(429, { hasChallengeCookie: true, serverVendor: "cloudflare", hasCfRay: true });
  assert.equal(detectAntibotBlock(r)?.signal, "cloudflare-challenge-cookie");
});

test("detectAntibotBlock: ordinary 403 auth wall (no vendor signals) → does NOT fire", () => {
  assert.equal(detectAntibotBlock(result(403)), null);
});

test("detectAntibotBlock: ordinary 503 service-unavailable → does NOT fire", () => {
  assert.equal(detectAntibotBlock(result(503)), null);
});

test("detectAntibotBlock: vendor signals but status 200 → does NOT fire (status not in the anti-bot set)", () => {
  assert.equal(detectAntibotBlock(result(200, { hasCfMitigated: true, hasChallengeBody: true })), null);
});

test("detectAntibotBlock: vendor cookie WITHOUT vendor attribution → does NOT fire", () => {
  // A bare cookie with no server/cf-ray attribution is not enough (could be a
  // colliding cookie name on a non-vendor site).
  assert.equal(detectAntibotBlock(result(403, { hasChallengeCookie: true, serverVendor: "none", hasCfRay: false })), null);
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

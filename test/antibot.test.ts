import assert from "node:assert/strict";
import { test } from "node:test";
import { detectAntibotBlock } from "../src/application/antibot.ts";
import type { AntiBotEvidence, FetcherResult } from "../src/application/ports/fetcher.ts";

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

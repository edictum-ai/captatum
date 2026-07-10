// ReDoS-shape guard for the anti-bot marker + verification-phrase regexes (#151). These are
// implementation-detail tests (like test/dos-extraction.test.ts for the extract layer), NOT part of
// the frozen acceptance contract — they live here in the non-frozen suite. The SHAPE test is
// load-bearing: a flood THROUGH computeAntiBotEvidence is bounded by the scan window, so only a
// direct test of the regex object over a large crafted flood guards a future edit that adds a
// quantifier. Uses the runner-relative ratio method (REDOS-5) so a slow runner cannot flake it.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { CHALLENGE_BODY_MARKERS, VERIFICATION_PHRASES } from "../src/infrastructure/http/antibot-evidence.ts";

const LIN_RATIO = 40; // linear ≲ 10 (+noise) vs quadratic ≈ 100, at 10× input — wide gap, runner-relative
const CEILING_MS = 5_000; // ~10× healthy; a catastrophic flood is tens of seconds

function timedMs<T>(fn: () => T): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

/** Assert `regex.test` is LINEAR on `build`'s 10×-scaled flood + bounded in absolute time. A
 *  near-miss flood (no complete match) forces a full scan; a future quantifier would blow the ratio. */
function assertLinearRegex(label: string, regex: RegExp, build: (units: number) => string): void {
  const smallUnits = 4_000;
  const largeUnits = 40_000; // 10× — linear ⇒ ratio ≲ 10; quadratic ⇒ ≈ 100
  const tSmall = timedMs(() => regex.test(build(smallUnits)));
  const tLarge = timedMs(() => regex.test(build(largeUnits)));
  const ratio = tLarge / Math.max(tSmall, 0.1);
  assert.ok(
    ratio < LIN_RATIO,
    `${label}: ${largeUnits}/${smallUnits} ratio ${ratio.toFixed(1)}× (linear ≲ 10, catastrophic ≈ 100) — likely a ReDoS regression ` +
      `(tSmall=${tSmall.toFixed(2)}ms, tLarge=${tLarge.toFixed(2)}ms)`,
  );
  assert.ok(
    tLarge < CEILING_MS,
    `${label}: tLarge ${tLarge.toFixed(2)}ms exceeded the ${CEILING_MS}ms ceiling — pathological slowdown`,
  );
}

test("#151 ReDoS: CHALLENGE_BODY_MARKERS is linear on an adversarial near-miss flood (no early match → full scan)", () => {
  // Each unit is a NEAR-miss of a marker (last char dropped) + an 'X' separator, so the string
  // contains NO complete marker — .test() cannot short-circuit and must scan the whole flood
  // (a matching flood would return true at byte 0 and measure noise). A future quantifier
  // (e.g. `captcha-[a-z]+`) would backtrack catastrophically here.
  assertLinearRegex(
    "CHALLENGE_BODY_MARKERS",
    CHALLENGE_BODY_MARKERS,
    (n) => "cdn-cgi/challenge-platforX__cf_chX_abcXpx-captchXcaptcha-deliverXincapsula incident iX".repeat(n),
  );
  assert.ok(CHALLENGE_BODY_MARKERS.test("captcha-delivery"), "the regex DOES match the real marker");
});

test("#151 ReDoS: VERIFICATION_PHRASES is linear on an adversarial near-miss flood", () => {
  assertLinearRegex(
    "VERIFICATION_PHRASES",
    VERIFICATION_PHRASES,
    (n) => "verifying your browseXchecking your browseXverify you are a humaX".repeat(n),
  );
  assert.ok(VERIFICATION_PHRASES.test("verifying your browser"), "the regex DOES match the real phrase");
});

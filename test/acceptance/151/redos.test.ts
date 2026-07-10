// FROZEN acceptance suite for #151 — ReDoS guards for the anti-bot marker + verification-phrase
// regexes (criterion 8a: SHAPE is linear, tested DIRECTLY bypassing the 4096-byte bodyHead cap)
// and the 4096-cap bound (criterion 8b: a marker past byte 4096 is not detected). The SHAPE test
// is load-bearing: bodyHead is hard-capped at 4096 bytes, so a flood THROUGH computeAntiBotEvidence
// is trivially O(1) and proves nothing about regex shape — only a direct test of the regex object
// over a large crafted flood guards a future edit that adds a quantifier. Mirrors the runner-relative
// ratio method of test/dos-extraction.test.ts (REDOS-5) so a slow runner cannot flake it.
// Spec: docs/specs/151-antibot-bot-verification.md — criteria 8a, 8b.

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  CHALLENGE_BODY_MARKERS,
  VERIFICATION_PHRASES,
  computeAntiBotEvidence,
} from "../../../src/infrastructure/http/antibot-evidence.ts";

const LIN_RATIO = 40; // linear ≲ 10 (+noise) vs quadratic ≈ 100, at 10× input — wide gap, runner-relative
const CEILING_MS = 5_000; // ~10× healthy; a catastrophic flood is tens of seconds

function timedMs<T>(fn: () => T): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

/**
 * Assert `regex.test` is LINEAR on `build`'s 10×-scaled flood and bounded in absolute time.
 * An adversarial flood of partial alternation prefixes stresses the alternation; a future
 * quantifier would make the ratio blow past LIN_RATIO. (Mirrors dos-extraction assertLinear.)
 */
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

// --- 8a: SHAPE — the marker + phrase regexes are linear (no quantified backtracking) ---

test("8a: CHALLENGE_BODY_MARKERS is linear on an adversarial partial-marker flood", () => {
  // A mix of partial vendor prefixes (each a near-miss of a marker) maximizes alternation churn.
  assertLinearRegex(
    "CHALLENGE_BODY_MARKERS",
    CHALLENGE_BODY_MARKERS,
    (n) => "cdn-cgi/challenge-platformx__cf_chlx_abckxpx-captchaxcaptcha-deliveryxincapsula incident idx".repeat(n),
  );
  // Correctness on the same large flood: the marker alternation DOES contain matching substrings.
  assert.ok(CHALLENGE_BODY_MARKERS.test("cdn-cgi/challenge-platform".repeat(100)));
});

test("8a: VERIFICATION_PHRASES is linear on an adversarial partial-phrase flood", () => {
  assertLinearRegex(
    "VERIFICATION_PHRASES",
    VERIFICATION_PHRASES,
    (n) => "verifying your browseXchecking your browseXverify you are a humaX".repeat(n),
  );
  assert.ok(VERIFICATION_PHRASES.test("verifying your browser".repeat(100)));
});

// --- 8b: CAP — the 4096-byte bodyHead bound. A marker/phrase placed PAST byte 4096 is not seen. ---

test("8b: a challenge marker past byte 4096 is NOT detected (the bodyHead cap truncates first)", () => {
  const filler = "x".repeat(4096);
  const body = new TextEncoder().encode(filler + "captcha-delivery");
  const ev = computeAntiBotEvidence({ "content-type": "text/html" }, body, 403);
  assert.equal(
    ev.hasChallengeBody,
    false,
    "the marker sits beyond the 4096-byte bodyHead cap, so it must not be detected",
  );
});

test("8b: a verification phrase past byte 4096 is NOT detected (the bodyHead cap truncates first)", () => {
  const filler = "x".repeat(4096);
  const body = new TextEncoder().encode(filler + "verifying your browser");
  const ev = computeAntiBotEvidence({ "content-type": "text/html" }, body, 429) as Record<string, unknown>;
  assert.equal(
    ev.hasVerificationPhrase,
    false,
    "the phrase sits beyond the 4096-byte bodyHead cap, so it must not be detected",
  );
});

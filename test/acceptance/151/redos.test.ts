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

test("8a: CHALLENGE_BODY_MARKERS is linear on an adversarial near-miss flood (no early match → full scan)", () => {
  // Each unit is a NEAR-miss of a marker (last char dropped) + an 'X' separator, so the string
  // contains NO complete marker — .test() cannot short-circuit and must scan the whole flood
  // (a matching flood would return true at byte 0 and measure noise). Stresses the alternation; a
  // future quantifier would backtrack catastrophically here.
  assertLinearRegex(
    "CHALLENGE_BODY_MARKERS",
    CHALLENGE_BODY_MARKERS,
    (n) => "cdn-cgi/challenge-platforX__cf_chX_abcXpx-captchXcaptcha-deliverXincapsula incident iX".repeat(n),
  );
  // Correctness: the regex DOES match the real markers.
  assert.ok(CHALLENGE_BODY_MARKERS.test("captcha-delivery"));
});

test("8a: VERIFICATION_PHRASES is linear on an adversarial partial-phrase flood", () => {
  assertLinearRegex(
    "VERIFICATION_PHRASES",
    VERIFICATION_PHRASES,
    (n) => "verifying your browseXchecking your browseXverify you are a humaX".repeat(n),
  );
  assert.ok(VERIFICATION_PHRASES.test("verifying your browser".repeat(100)));
});

// --- 8b: scan windows. Markers scan a bounded 64KB head window; the status-gated phrase scans the
//     FULL body (it can sit DEEP under a large <head> — Vercel's checkpoint buries it ~28KB in). ---

test("8b: a challenge marker past the 64KB scan window is NOT detected", () => {
  const body = new TextEncoder().encode("x".repeat(65536) + "captcha-delivery");
  const ev = computeAntiBotEvidence({ "content-type": "text/html" }, body, 403);
  assert.equal(ev.hasChallengeBody, false, "the marker sits past the 64KB marker-scan window");
});

test("8b: a verification phrase DEEP in the body IS detected (full-body phrase scan — Vercel/HashiCorp buries it ~28KB in)", () => {
  const body = new TextEncoder().encode("x".repeat(30000) + "verifying your browser");
  const ev = computeAntiBotEvidence({ "content-type": "text/html" }, body, 429) as Record<string, unknown>;
  assert.equal(ev.hasVerificationPhrase, true, "a deep phrase is caught by the status-gated full-body phrase scan");
});

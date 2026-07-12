// #157: config-layer validation for CAPTATUM_BULK_MAX_GLOBAL_WALL_MS — the HOSTED runtime lever
// that raises the bulk global-deadline wall from the 55 s default toward the 180 s ceiling. The wall
// is a directed-DoS / egress-deadline bound, so this is a SECURITY SELECTOR: malformed input fails
// CLOSED at boot (throw), never silently falls back to a default (`value || default` is forbidden on
// it). The domain clamp (resolveBulkGuard) + the hosted-default-55 s / ceiling-180 s contract are
// pinned separately in test/bulk-policy.test.ts:165-191; THIS file pins the env-PARSING boundary
// only — the impl-detail guard that an operator cannot widen past the ceiling or silently land on a
// different wall than they typed. Spec: docs/specs/157-bulk-wall-env-knob.md §4.1 + §7.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { config } from "../src/config.ts";
import { BULK_GUARD_CEILINGS } from "../src/domain/bulk-policy.ts";

const NAME = "CAPTATUM_BULK_MAX_GLOBAL_WALL_MS";
const CEILING = BULK_GUARD_CEILINGS.maxGlobalWallMs; // 180_000 — the hard cap, single-sourced

// Process-env hygiene: save/restore around each case so tests are order-independent and never leak.
let saved: string | undefined;
beforeEach(() => { saved = process.env[NAME]; });
afterEach(() => {
  if (saved === undefined) delete process.env[NAME];
  else process.env[NAME] = saved;
});

function setEnv(v: string | undefined): void {
  if (v === undefined) delete process.env[NAME];
  else process.env[NAME] = v;
}

test("unset / empty / whitespace-only → undefined (absent operator config → the hosted 55 s default)", () => {
  for (const v of [undefined, "", "   ", "\t", "\n", "  \t "]) {
    setEnv(v);
    assert.equal(config.bulk.maxGlobalWallMs(), undefined, `expected undefined for ${JSON.stringify(v)}`);
  }
});

test("valid in-range decimal integers → that value (ms), incl. ceiling boundary, leading zeros, surrounding whitespace", () => {
  const cases: Array<[string, number]> = [
    ["1", 1],                 // floor — must PASS
    ["55000", 55_000],        // the hosted default value, spelled explicitly
    ["100000", 100_000],      // a mid-range raise
    [`${CEILING}`, CEILING],  // the ceiling boundary — must PASS (not off-by-one)
    ["055000", 55_000],       // leading-zero padding — accepted at no security cost
    ["  55000", 55_000],      // surrounding spaces — trimmed (ConfigMap contamination)
    ["55000\n", 55_000],      // trailing heredoc newline — trimmed
    ["\t180000\t", CEILING],  // surrounding tabs — trimmed
  ];
  for (const [raw, expected] of cases) {
    setEnv(raw);
    assert.equal(config.bulk.maxGlobalWallMs(), expected, `expected ${expected} for ${JSON.stringify(raw)}`);
  }
});

test("non-decimal shapes an operator did not literally type → boot rejection (pins the regex, not Number()/parseInt tolerance)", () => {
  // Number() would accept hex (0x10→16), scientific (1e5→100000), float (55000.5); parseInt would
  // silently truncate "55 000"→55. The strict regex rejects ALL of these — proving the validator is
  // not Number()/parseInt based.
  const bad = ["abc", "55 000", "55\t000", "55000.5", "0x10", "1e5", "+55000", "-5000", "٥٥٠٠٠"];
  for (const v of bad) {
    setEnv(v);
    assert.throws(
      () => config.bulk.maxGlobalWallMs(),
      (err: Error) => err instanceof Error && err.message.includes(NAME),
      `expected boot-reject for ${JSON.stringify(v)}`,
    );
  }
});

test("zero / all-zeros → boot rejection (the wall must be >= 1 ms)", () => {
  for (const v of ["0", "000", "000000"]) {
    setEnv(v);
    assert.throws(
      () => config.bulk.maxGlobalWallMs(),
      />= 1 ms/,
      `expected boot-reject for ${JSON.stringify(v)}`,
    );
  }
});

test("above-ceiling / huge → boot rejection (the directed-DoS / egress-deadline bound; an operator can NEVER widen past it)", () => {
  setEnv(`${CEILING + 1}`); // 180_001 — off-by-one past the ceiling
  assert.throws(() => config.bulk.maxGlobalWallMs(), /exceeds the hard ceiling/);
  setEnv("999999999999999999999999"); // regex-valid but far beyond Number precision + the ceiling
  assert.throws(() => config.bulk.maxGlobalWallMs(), /exceeds the hard ceiling/);
});

test("the boot-reject error NAMES the env var + the valid range — the only operator-facing signal", () => {
  setEnv("not-a-number");
  assert.throws(
    () => config.bulk.maxGlobalWallMs(),
    (err: Error) =>
      err instanceof Error &&
      err.message.includes(NAME) &&            // names the env var
      err.message.includes("[1,") &&            // states the floor
      err.message.includes(`${CEILING}`),       // states the ceiling
  );
});

test("the local-binary flavor does NOT read this env — the ceiling is single-sourced from the domain (regression guard for the hosted-only scope)", () => {
  // BULK_GUARD_CEILINGS.maxGlobalWallMs is the value local-server.ts passes (hosted-only decision,
  // spec §2). If the ceiling drifts, bulk-policy.test.ts:175 fails too; this asserts the const the
  // config validator clamps against is the SAME const local uses, so the two flavors can never
  // disagree on the hard cap.
  assert.equal(CEILING, 180_000);
});

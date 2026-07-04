import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyHealth,
  recordOutcome,
  FAIL_THRESHOLD,
  HEALTH_WINDOW,
  RECOVER_SUCCESSES,
} from "../src/infrastructure/llm/model-health.ts";

// #82: sticky per-model health — demote only on SUSTAINED hard failure; soft/garbage output is a
// no-op; recover after consecutive successes. (Replaces the jumpy EMA "bandit" #48-C killed.)

test("model-health: demotes at FAIL_THRESHOLD hard failures, not before (#82)", () => {
  const h = emptyHealth();
  for (let i = 1; i < FAIL_THRESHOLD; i++) {
    recordOutcome(h, "hard_fail");
    assert.equal(h.demotion, 0, `no demotion at ${i} failures (below threshold)`);
  }
  recordOutcome(h, "hard_fail");
  assert.equal(h.demotion, 1, "demoted once at the threshold");
});

test("model-health: soft outcomes never demote and never touch the window (#82)", () => {
  const h = emptyHealth();
  for (let i = 0; i < 10; i++) recordOutcome(h, "soft");
  assert.equal(h.demotion, 0);
  assert.equal(h.recent.length, 0, "soft does not push into the window");
  assert.equal(h.consecutiveSuccesses, 0);
});

test("model-health: recovers (clears demotion + window) after RECOVER_SUCCESSES successes (#82)", () => {
  const h = emptyHealth();
  for (let i = 0; i < FAIL_THRESHOLD; i++) recordOutcome(h, "hard_fail");
  assert.equal(h.demotion, 1);
  for (let i = 1; i < RECOVER_SUCCESSES; i++) {
    recordOutcome(h, "success");
    assert.equal(h.demotion, 1, `${i} success(es) do not yet recover`);
  }
  recordOutcome(h, "success");
  assert.equal(h.demotion, 0, "recovered after RECOVER_SUCCESSES consecutive successes");
  assert.equal(h.recent.length, 0, "window cleared on recovery");
  assert.equal(h.consecutiveSuccesses, 0);
});

test("model-health: the failure window caps at HEALTH_WINDOW (#82)", () => {
  const h = emptyHealth();
  for (let i = 0; i < HEALTH_WINDOW + 3; i++) recordOutcome(h, "hard_fail");
  assert.equal(h.recent.length, HEALTH_WINDOW);
  assert.equal(h.demotion, 1);
});

test("model-health: a hard failure between successes resets the recovery count (#82)", () => {
  const h = emptyHealth();
  for (let i = 0; i < FAIL_THRESHOLD; i++) recordOutcome(h, "hard_fail");
  assert.equal(h.demotion, 1);
  recordOutcome(h, "success");
  recordOutcome(h, "hard_fail"); // resets consecutiveSuccesses before recovery
  recordOutcome(h, "success");
  assert.equal(h.demotion, 1, "still demoted — the hard failure reset the recovery run");
});

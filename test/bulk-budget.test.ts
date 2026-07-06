import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetTracker } from "../src/application/use-cases/bulk-budget.ts";
import type { ClockPort } from "../src/application/ports/clock.ts";

function fakeClock(start = 1000): ClockPort & { now: number } {
  return { now: start, nowMs() { return this.now; } } as ClockPort & { now: number };
}

test("BudgetTracker: beforeSeed reserves bytes; dispatch false when egress cap full", () => {
  const clock = fakeClock();
  const t = new BudgetTracker({ clock, maxGlobalEgressBytes: 100, maxGlobalWallMs: 5000, maxTransformCostUsd: 1, perSeedTransformCostUsd: 0.02, perSeedMaxBytes: 30 });
  // 3 seeds × 30 = 90 settle; the 4th reservation (90+30=120 > 100) is refused.
  for (let i = 0; i < 3; i++) {
    const b = t.beforeSeed();
    assert.equal(b.dispatch, true);
    t.afterSeed({ bytes: 30, transformReserved: b.runTransform });
  }
  const blocked = t.beforeSeed();
  assert.equal(blocked.dispatch, false);
  assert.equal(blocked.reason, "egress_bytes");
  assert.equal(t.bytesUsed, 90);
});

test("BudgetTracker: cost fail-soft — runTransform false when cost budget exhausted (fetch still happens)", () => {
  const clock = fakeClock();
  const t = new BudgetTracker({ clock, maxGlobalEgressBytes: 1_000_000, maxGlobalWallMs: 5000, maxTransformCostUsd: 0.10, perSeedTransformCostUsd: 0.02, perSeedMaxBytes: 100 });
  // 5 transforms @ 0.02 = 0.10 exhausts the global cost cap.
  for (let i = 0; i < 5; i++) {
    const b = t.beforeSeed();
    assert.equal(b.dispatch, true);
    assert.equal(b.runTransform, true, `seed ${i} should be allowed to transform`);
    t.afterSeed({ bytes: 10, costUsd: 0.02, transformReserved: true });
  }
  // 6th seed: cost reservation (0.10 + 0.02 > 0.10) does not fit → fail-soft RAW.
  const soft = t.beforeSeed();
  assert.equal(soft.dispatch, true, "the fetch still happens");
  assert.equal(soft.runTransform, false, "the transform is skipped (fail-soft to raw)");
});

test("BudgetTracker: post-transform re-check short-circuits when actual cost overshoots the reservation", () => {
  const clock = fakeClock();
  // perSeed 0.02 (reservation fits: 0.02 ≤ cap 0.10) but the model actually spends 0.11 on
  // the transform → the post-transform global re-check catches the overshoot and short-circuits.
  const t = new BudgetTracker({ clock, maxGlobalEgressBytes: 1_000_000, maxGlobalWallMs: 5000, maxTransformCostUsd: 0.10, perSeedTransformCostUsd: 0.02, perSeedMaxBytes: 100 });
  const b = t.beforeSeed();
  assert.equal(b.runTransform, true);
  const after = t.afterSeed({ bytes: 10, costUsd: 0.11, transformReserved: true });
  assert.equal(after.shortCircuit, true);
  assert.equal(after.reason, "transform_cost");
  assert.equal(t.costUsed, 0.11);
});

test("BudgetTracker: reservation invariant — total fetched never exceeds the egress cap", () => {
  // cap 100, perSeed 30: the gate `settled+reserved+30 ≤ 100` allows at most 3 concurrent
  // (reserved 90) and, once they settle (settled 90), refuses everything else — so the 4th
  // seed NEVER fetches. That is the reservation tightening: aggregate egress ≤ cap.
  const clock = fakeClock();
  const t = new BudgetTracker({ clock, maxGlobalEgressBytes: 100, maxGlobalWallMs: 5000, maxTransformCostUsd: 1, perSeedTransformCostUsd: 0.01, perSeedMaxBytes: 30 });
  let dispatched = 0;
  for (let i = 0; i < 4; i++) {
    const b = t.beforeSeed();
    if (!b.dispatch) break;
    dispatched++;
    t.afterSeed({ bytes: 30, transformReserved: false }); // settle immediately (serial)
  }
  assert.equal(dispatched, 3, "the 4th seed is refused once settled reaches 90 (90+30>100)");
  assert.equal(t.bytesUsed, 90);
  // Even after all settle, a further seed is refused (cap full).
  assert.equal(t.beforeSeed().dispatch, false);
});

test("BudgetTracker: wallExceeded flips after the deadline", () => {
  const clock = fakeClock(1000);
  const t = new BudgetTracker({ clock, maxGlobalEgressBytes: 1000, maxGlobalWallMs: 5000, maxTransformCostUsd: 1, perSeedTransformCostUsd: 0.01, perSeedMaxBytes: 10 });
  assert.equal(t.wallExceeded(), false);
  clock.now = 6000;
  assert.equal(t.wallExceeded(), true);
});

test("BudgetTracker: transformReserved false (raw seed) records bytes but no cost + no re-check", () => {
  const clock = fakeClock();
  const t = new BudgetTracker({ clock, maxGlobalEgressBytes: 1000, maxGlobalWallMs: 5000, maxTransformCostUsd: 0.001, perSeedTransformCostUsd: 0.01, perSeedMaxBytes: 10 });
  const b = t.beforeSeed();
  assert.equal(b.runTransform, false, "cost cap 0.001 < perSeed 0.01 → fail-soft raw immediately");
  const after = t.afterSeed({ bytes: 10, transformReserved: false });
  assert.equal(after.shortCircuit, false);
  assert.equal(t.bytesUsed, 10);
  assert.equal(t.costUsed, 0);
});

test("BudgetTracker: a $0 cost cap (perSeed clamps to 0) skips the transform — no paid call slips through", () => {
  // maxTransformCostUsd 0 → resolveBulkGuard clamps perSeed to 0; without the perSeed>0 guard,
  // `0+0+0 <= 0` would admit one paid transform under a declared $0 ceiling. The guard fails-soft
  // to raw so no LLM bill is ever incurred.
  const clock = fakeClock();
  const t = new BudgetTracker({ clock, maxGlobalEgressBytes: 1_000_000, maxGlobalWallMs: 5000, maxTransformCostUsd: 0, perSeedTransformCostUsd: 0, perSeedMaxBytes: 100 });
  const b = t.beforeSeed();
  assert.equal(b.dispatch, true, "the fetch still happens");
  assert.equal(b.runTransform, false, "a $0 ceiling skips the transform entirely");
});

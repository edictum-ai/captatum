import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClockPort } from "../src/application/ports/clock.ts";
import { InMemoryBulkQuotaPort } from "../src/application/use-cases/in-memory-bulk-quota.ts";
import { NoopBulkQuotaPort } from "../src/application/ports/bulk-quota.ts";

/** A mutable clock the test advances explicitly (no real time). */
function manualClock(start = 1000): ClockPort & { now: number } {
  return { now: start, nowMs() { return this.now; } } as ClockPort & { now: number };
}

test("InMemoryBulkQuotaPort: allows reservations under the limit", async () => {
  const clk = manualClock();
  const q = new InMemoryBulkQuotaPort({ clock: clk, windowSeconds: 60, limit: 100 });
  const r1 = await q.tryReserve({ tenant: "tA", seeds: 30 });
  assert.equal(r1.ok, true);
  if (r1.ok) { assert.equal(r1.used, 30); assert.equal(r1.reserved, 30); }
  const r2 = await q.tryReserve({ tenant: "tA", seeds: 30 });
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.used, 60, "the rolling sum accumulates within the window");
});

test("InMemoryBulkQuotaPort: denies a reservation that would exceed the limit (bulk_quota_exceeded)", async () => {
  const clk = manualClock();
  const q = new InMemoryBulkQuotaPort({ clock: clk, windowSeconds: 60, limit: 100 });
  await q.tryReserve({ tenant: "tA", seeds: 80 });
  const over = await q.tryReserve({ tenant: "tA", seeds: 30 }); // 80 + 30 = 110 > 100
  assert.equal(over.ok, false);
  if (!over.ok && over.code === "bulk_quota_exceeded") {
    assert.equal(over.used, 80);
    assert.equal(over.limit, 100);
    assert.equal(over.windowSeconds, 60);
    assert.ok(over.retryAfterMs !== undefined && over.retryAfterMs > 0, "carries a retryAfterMs hint");
  } else assert.fail("expected bulk_quota_exceeded");
});

test("InMemoryBulkQuotaPort: reservations roll off after the window (a retry fits later)", async () => {
  const clk = manualClock();
  const q = new InMemoryBulkQuotaPort({ clock: clk, windowSeconds: 60, limit: 100 });
  await q.tryReserve({ tenant: "tA", seeds: 80 });
  const over = await q.tryReserve({ tenant: "tA", seeds: 30 });
  assert.equal(over.ok, false, "over the limit within the window");
  // Advance past the window → the 80-seed reservation expires.
  clk.now += 61 * 1000;
  const after = await q.tryReserve({ tenant: "tA", seeds: 30 });
  assert.equal(after.ok, true, "the reservation rolled off after the window");
});

test("InMemoryBulkQuotaPort: retryAfterMs ≈ the oldest reservation's remaining window", async () => {
  const clk = manualClock();
  const q = new InMemoryBulkQuotaPort({ clock: clk, windowSeconds: 60, limit: 100 });
  await q.tryReserve({ tenant: "tA", seeds: 100 }); // fill the window
  clk.now += 20 * 1000; // 20s in: oldest expires in ~40s
  const over = await q.tryReserve({ tenant: "tA", seeds: 1 });
  if (!over.ok && over.code === "bulk_quota_exceeded") {
    assert.ok(over.retryAfterMs! >= 39_000 && over.retryAfterMs! <= 40_000, `retryAfterMs ≈ 40s; got ${over.retryAfterMs}`);
  } else assert.fail("expected bulk_quota_exceeded");
});

test("InMemoryBulkQuotaPort: tenants are isolated (tA's usage does not bind tB)", async () => {
  const clk = manualClock();
  const q = new InMemoryBulkQuotaPort({ clock: clk, windowSeconds: 60, limit: 100 });
  await q.tryReserve({ tenant: "tA", seeds: 100 });
  const b = await q.tryReserve({ tenant: "tB", seeds: 100 });
  assert.equal(b.ok, true, "tB has its own window");
});

test("InMemoryBulkQuotaPort: a missing tenant id is fail-closed (bulk_quota_store_error)", async () => {
  const q = new InMemoryBulkQuotaPort({ clock: manualClock(), windowSeconds: 60, limit: 100 });
  const r = await q.tryReserve({ tenant: "", seeds: 5 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "bulk_quota_store_error", "missing tenant → fail-closed refusal");
});

test("InMemoryBulkQuotaPort: rejects bad config at construction", () => {
  assert.throws(() => new InMemoryBulkQuotaPort({ clock: manualClock(), windowSeconds: 0, limit: 10 }), /windowSeconds/);
  assert.throws(() => new InMemoryBulkQuotaPort({ clock: manualClock(), windowSeconds: 60, limit: 0 }), /limit/);
});

test("NoopBulkQuotaPort: admits everything (local-binary flavor is unbounded)", async () => {
  const q = new NoopBulkQuotaPort();
  const r = await q.tryReserve({ tenant: "any", seeds: 9999 });
  assert.equal(r.ok, true);
});

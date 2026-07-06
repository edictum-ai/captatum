import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClockPort } from "../src/application/ports/clock.ts";
import type { CaptatumContext } from "../src/application/ports/captatum-context.ts";
import type { CaptatumExecutorPort as ExecPort } from "../src/application/ports/captatum-executor.ts";
import { PlatformAdapterRegistry } from "../src/application/ports/platform-adapter.ts";
import type { Result } from "../src/domain/result.ts";
import { CaptatumBulkUseCase } from "../src/application/use-cases/captatum-bulk.ts";
import { Semaphore } from "../src/application/use-cases/bulk-concurrency.ts";

function fakeClock(start = 1000): ClockPort & { now: number } {
  return { now: start, nowMs() { return this.now; } } as ClockPort & { now: number };
}

/** A clock that returns `base` for the first `jumpAfter` reads (execute start + budget
 *  construction) then `base + jump` — so the per-seed wallExceeded() check trips without
 *  waiting real time. */
function steppingClock(base = 1000, jumpAfter = 2, jump = 200_000): ClockPort {
  let n = 0;
  return { nowMs() { n++; return n <= jumpAfter ? base : base + jump; } };
}

function okResult(url: string, opts: { bytes?: number; redirects?: string[]; finalUrl?: string; costUsd?: number; output?: "raw" | "summary" } = {}): Result {
  const bytes = opts.bytes ?? 100;
  return {
    url, bytes, code: 200, codeText: "OK", durationMs: 10, result: `content for ${url}`,
    schemaVersion: 1, finalUrl: opts.finalUrl ?? url, redirects: (opts.redirects ?? []).map((u) => ({ url: u, status: 302 })),
    tier: 1, output: opts.output ?? "raw",
    platform: { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier1" },
    jsRequired: false, resolvedVia: "tier1-text", attempts: [], contentType: "text/html",
    timings: { totalMs: 10, fetchMs: 10 }, errors: [],
    ...(opts.costUsd !== undefined ? { transform: { provider: "openrouter", model: "x", costUsd: opts.costUsd, inTokens: 10, outTokens: 20 } } : {}),
  };
}

/** Fake executor: returns a canned Result per URL (or throws to simulate a per-seed failure).
 *  Output-aware: a raw request strips the transform (realistic — raw fetches don't bill the LLM). */
class FakeExecutor implements ExecPort {
  defaultOutput = "raw" as const;
  readonly results = new Map<string, Result>();
  readonly throws = new Set<string>();
  calls = 0;
  async execute(input: unknown, context?: CaptatumContext): Promise<Result> {
    const url = (input as { url: string }).url;
    const requestedOutput = (input as { output?: string }).output;
    this.calls++;
    if (context?.signal?.aborted) return rejectResult(url, "timeout", "aborted");
    if (this.throws.has(url)) throw new Error(`boom: ${url}`);
    const r = this.results.get(url);
    if (!r) return rejectResult(url, "not_found", `no fake result for ${url}`);
    if (r.tier === "error") return { ...r };
    if (requestedOutput === "raw") return { ...r, output: "raw", transform: undefined };
    return { ...r };
  }
}

function rejectResult(url: string, code: string, message: string): Result {
  return {
    url, bytes: 0, code: 0, codeText: "FETCH_REJECTED", durationMs: 1, result: message,
    schemaVersion: 1, finalUrl: url, redirects: [], tier: "error", output: "raw",
    platform: { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier1" },
    jsRequired: false, resolvedVia: "guarded-fetch", attempts: [], contentType: "",
    timings: { totalMs: 1, fetchMs: 1 }, errors: [{ code, message }],
  };
}

function makeBulk(exec: FakeExecutor, clock = fakeClock(), operator = {}): CaptatumBulkUseCase {
  return new CaptatumBulkUseCase({ executor: exec, adapters: new PlatformAdapterRegistry([]), clock, operator });
}

test("bulk happy path: 3 seeds, input-order results, status pass, totals sum bytes", async () => {
  const exec = new FakeExecutor();
  const urls = ["https://a.test/1", "https://b.test/2", "https://c.test/3"];
  for (const u of urls) exec.results.set(u, okResult(u));
  const res = await makeBulk(exec).execute({ urls });
  assert.equal(res.count, 3);
  assert.equal(res.status, "pass");
  assert.equal(res.passed, 3);
  assert.equal(res.failed, 0);
  assert.deepEqual(res.results.map((r) => r.url), urls, "input order preserved");
  assert.equal(res.totals.bytes, 300);
  assert.equal(res.totals.egressBytes, 300);
  assert.equal(res.ok, true);
  assert.equal(exec.calls, 3);
});

test("bulk pre-egress per-host cap: 12 seeds on one host → 10 processed, 2 truncated (shaping)", async () => {
  const exec = new FakeExecutor();
  const urls = Array.from({ length: 12 }, (_, i) => `https://victim.test/j${i}`);
  for (const u of urls) exec.results.set(u, okResult(u));
  // High burst so the rate gate doesn't serialize (this test is about the COUNT cap, not the rate).
  const res = await makeBulk(exec, fakeClock(), { maxPerHostInflight: 20 }).execute({ urls });
  assert.equal(res.count, 10);
  assert.equal(res.truncated, 2);
  assert.equal(res.clamp.perHostTruncated.length, 1);
  assert.deepEqual(res.clamp.perHostTruncated[0], { host: "victim.test", kept: 10, dropped: 2 });
  assert.equal(res.status, "pass");
});

test("bulk: per-seed failure is normal (one fail entry), not a whole-call error", async () => {
  const exec = new FakeExecutor();
  exec.results.set("https://a.test/1", okResult("https://a.test/1"));
  exec.throws.add("https://b.test/2"); // executor throws → synthetic fail
  exec.results.set("https://c.test/3", rejectResult("https://c.test/3", "private_ip", "blocked"));
  const res = await makeBulk(exec).execute({ urls: ["https://a.test/1", "https://b.test/2", "https://c.test/3"] });
  assert.equal(res.count, 3);
  assert.equal(res.status, "partial");
  assert.equal(res.passed, 1);
  assert.equal(res.failed, 2);
  assert.equal(res.failures.length, 2);
});

test("bulk budget: egress-byte cap short-circuits remaining seeds (bulk_budget_exceeded:egress_bytes)", async () => {
  const exec = new FakeExecutor();
  // Serial dispatch (maxConcurrency:1) so seed3's beforeSeed sees seed1+seed2's settled bytes.
  // Each seed returns 60MB; after seed2 settles (120MB > 100MB cap) the post-seed re-check
  // short-circuits, and seed3/seed4 are refused at dispatch (egress_bytes reservation).
  const big = 60 * 1024 * 1024;
  const urls = ["https://a.test/1", "https://b.test/2", "https://c.test/3", "https://d.test/4"];
  for (const u of urls) exec.results.set(u, okResult(u, { bytes: big }));
  const res = await makeBulk(exec, fakeClock(), { maxConcurrency: 1 }).execute({ urls });
  assert.equal(res.count, 4);
  assert.ok(res.capBreaches.some((c) => c.startsWith("bulk_budget_exceeded:egress_bytes")), `got ${res.capBreaches}`);
  assert.ok(res.failed >= 2, `>=2 seeds aborted by the byte cap; got ${res.failed}`);
  assert.ok(res.results.filter((r) => r.status === "pass").length === 2, "exactly seed1+seed2 fetched before the cap bit");
});

test("bulk wall: a deadline-crossing clock marks every seed bulk_deadline_exceeded", async () => {
  const exec = new FakeExecutor();
  exec.results.set("https://a.test/1", okResult("https://a.test/1"));
  exec.results.set("https://a.test/2", okResult("https://a.test/2"));
  // steppingClock: the first 2 nowMs() reads (execute start + budget construction) return the
  // base time; every subsequent read (the per-seed wallExceeded check) returns base+200s, past
  // the 180s default wall → both seeds abort before fetching.
  const res = await new CaptatumBulkUseCase({ executor: exec, adapters: new PlatformAdapterRegistry([]), clock: steppingClock(), operator: {} }).execute({ urls: ["https://a.test/1", "https://a.test/2"] });
  assert.equal(res.count, 2);
  assert.equal(res.results[0].status, "fail");
  assert.equal(res.results[0].codeText, "bulk_deadline_exceeded");
  assert.equal(res.results[1].codeText, "bulk_deadline_exceeded");
  assert.equal(exec.calls, 0, "no seed fetched — the wall aborted before dispatch");
});

test("bulk redirect-funnel: distinct seed domains → victim → post-settle union count disclosed", async () => {
  // 13 seeds on DISTINCT domains all redirect to victim.test. The pre-egress seed-domain cap
  // cannot see the funnel (each seed domain is fresh), so all 13 fetch; the post-settle union
  // count crosses maxPerHostInBulk (10) and the overshoot is DISCLOSED in capBreaches. The
  // egress overshoot is the documented discovery-lag risk; the disclosure is the accounting.
  const exec = new FakeExecutor();
  const urls = Array.from({ length: 13 }, (_, i) => `https://src${i}.test/p`);
  for (const u of urls) exec.results.set(u, okResult(u, { redirects: [`https://victim.test/x`], finalUrl: "https://victim.test/x" }));
  const res = await makeBulk(exec).execute({ urls });
  assert.equal(res.count, 13, "distinct seed domains are all processed (the funnel is not pre-egress detectable)");
  assert.ok(res.capBreaches.some((c) => c === "bulk_per_host_cap:victim.test"), `victim overshoot disclosed: ${res.capBreaches}`);
});

test("bulk: 0-count result when every URL is invalid (not a tool-level error)", async () => {
  const res = await makeBulk(new FakeExecutor()).execute({ urls: ["bad1", "bad2"] });
  assert.equal(res.count, 0);
  assert.equal(res.status, "fail");
  assert.equal(res.failures.length, 2);
});

test("bulk cost fail-soft: a tight cost cap drops later summary seeds to RAW (skip LLM, keep fetch)", async () => {
  const exec = new FakeExecutor();
  const urls = Array.from({ length: 6 }, (_, i) => `https://h${i}.test/p${i}`); // distinct hosts
  // Each summary transform costs $0.0005. With maxTransformCostUsd $0.002 + maxConcurrency 2, the
  // per-seed reservation is $0.001; once the cost budget is reserved/spent, further seeds fail-
  // soft to raw (the fetch still happens; the LLM is skipped). Cost is bounded by the cap.
  for (const u of urls) exec.results.set(u, okResult(u, { output: "summary", costUsd: 0.0005 }));
  const res = await makeBulk(exec, fakeClock(), { maxConcurrency: 2 }).execute({ urls, output: "summary", maxTransformCostUsd: 0.002 });
  const summary = res.results.filter((r) => r.output === "summary").length;
  const raw = res.results.filter((r) => r.output === "raw").length;
  assert.ok(summary >= 1, "at least one seed ran the transform");
  assert.ok(raw >= 1, "at least one seed fail-soft to raw once the cost budget was exhausted");
  assert.ok(res.totals.transformCostUsd <= 0.002 + 1e-9, `cost bounded by the cap; got ${res.totals.transformCostUsd}`);
});

test("Semaphore: an aborted waiter doesn't permanently drop capacity (regression for the handoff slot-loss)", async () => {
  const sem = new Semaphore(1);
  const holderAc = new AbortController();
  const holder = await sem.acquire(holderAc.signal); // take the only slot
  assert.equal(holder, true);
  // A second acquirer queues, then aborts before getting a slot.
  const waiterAc = new AbortController();
  const waiterP = sem.acquire(waiterAc.signal);
  waiterAc.abort();
  assert.equal(await waiterP, false, "the aborted waiter takes no slot");
  // Release the holder. A fresh acquirer MUST still get the slot — the aborted waiter spliced
  // itself out, so the release decrements active (it doesn't hand the slot to a dead waiter).
  sem.release();
  const freshAc = new AbortController();
  const got = await Promise.race([
    sem.acquire(freshAc).then((g) => g),
    new Promise<false>((r) => setTimeout(() => r(false), 200)),
  ]);
  assert.equal(got, true, "capacity was not lost to the aborted waiter (no deadlock)");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClockPort } from "../src/application/ports/clock.ts";
import type { CaptatumContext } from "../src/application/ports/captatum-context.ts";
import type { CaptatumExecutorPort as ExecPort } from "../src/application/ports/captatum-executor.ts";
import { PlatformAdapterRegistry } from "../src/application/ports/platform-adapter.ts";
import type { Result } from "../src/domain/result.ts";
import { CaptatumBulkUseCase } from "../src/application/use-cases/captatum-bulk.ts";
import { Semaphore } from "../src/application/use-cases/bulk-concurrency.ts";
import { raceWallAbort } from "../src/application/use-cases/bulk-seed.ts";

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
  assert.ok(res.capBreaches.includes("bulk_deadline_exceeded"), "the wall breach is disclosed in capBreaches");
});

test("bulk redirect-funnel quarantine: a redirect victim crossing the cap aborts remaining seeds (bound ≤ 13)", async () => {
  // 20 distinct-domain seeds all redirect to victim.test. The pre-egress seed-domain check
  // can't see the funnel, but once the post-settle union count crosses maxPerHostInBulk (10),
  // the quarantine stops dispatching the rest — bounding victim-touching seeds at
  // maxPerHostInBulk + maxConcurrency - 1 = 13 (in-flight finish, the rest abort).
  const exec = new FakeExecutor();
  const urls = Array.from({ length: 20 }, (_, i) => `https://src${i}.test/p`);
  for (const u of urls) exec.results.set(u, okResult(u, { redirects: [`https://victim.test/x`], finalUrl: "https://victim.test/x" }));
  const res = await makeBulk(exec, fakeClock(), { maxPerHostInflight: 50, maxConcurrency: 4 }).execute({ urls });
  const touched = res.results.filter((r) => r.resolvedVia !== "bulk-shortcut").length; // seeds that actually fetched victim
  assert.ok(touched >= 10, `at least maxPerHostInBulk fetched before the quarantine; got ${touched}`);
  assert.ok(touched <= 13, `victim-touching seed count ${touched} exceeds the maxPerHostInBulk + maxConcurrency - 1 = 13 bound`);
  assert.ok(res.capBreaches.some((c) => c.startsWith("bulk_per_host_cap")), `cap disclosed: ${res.capBreaches}`);
  assert.ok(res.results.some((r) => r.codeText === "bulk_per_host_cap"), "some funnel seeds aborted after the quarantine");
});

test("bulk redirect-funnel: a legitimate cross-domain bulk (no shared victim) is NOT quarantined", async () => {
  // 20 seeds on 20 distinct hosts, each redirecting to a DIFFERENT final host — no victim
  // crosses the cap, so the quarantine must NOT fire (all 20 process).
  const exec = new FakeExecutor();
  const urls = Array.from({ length: 20 }, (_, i) => `https://src${i}.test/p`);
  for (let i = 0; i < 20; i++) exec.results.set(urls[i], okResult(urls[i], { redirects: [`https://dest${i}.test/x`], finalUrl: `https://dest${i}.test/x` }));
  const res = await makeBulk(exec, fakeClock(), { maxPerHostInflight: 50, maxConcurrency: 4 }).execute({ urls });
  assert.equal(res.count, 20);
  assert.equal(res.failed, 0, "no quarantine — each destination host got exactly 1 seed");
  assert.ok(!res.capBreaches.some((c) => c.startsWith("bulk_per_host_cap")), "no per-host cap breach");
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

test("bulk: per-entry rejects (invalid URL) count toward status + failed (not a silent pass)", async () => {
  const exec = new FakeExecutor();
  exec.results.set("https://good.test/x", okResult("https://good.test/x"));
  const res = await makeBulk(exec).execute({ urls: ["https://good.test/x", "bad-url", "alsobad"] });
  assert.equal(res.count, 1, "1 processed seed");
  assert.equal(res.failed, 2, "the 2 invalid URLs count as failed");
  assert.equal(res.status, "partial", "rejects alongside a pass → partial, not pass");
  assert.equal(res.failures.length, 2);
});

test("bulk: ashby-embed (?ashby_jid=) seeds rejected per-entry (host-page probe not in v1 egress accounting)", async () => {
  const exec = new FakeExecutor();
  exec.results.set("https://good.test/x", okResult("https://good.test/x"));
  const res = await makeBulk(exec).execute({ urls: ["https://good.test/x", "https://careers.e2b.dev/?ashby_jid=abc-123"] });
  assert.equal(res.count, 1);
  assert.equal(res.failed, 1);
  assert.equal(res.failures.find((f) => f.url.includes("ashby_jid"))?.code, "ashby_embed_not_supported_in_bulk");
  assert.equal(exec.calls, 1, "the ashby-embed seed was NOT fetched (no uncounted host-page probe)");
});

test("bulk cost-skip: a summary seed downgraded to raw by the cost cap is partial + warned", async () => {
  const exec = new FakeExecutor();
  const urls = Array.from({ length: 6 }, (_, i) => `https://h${i}.test/p${i}`);
  for (const u of urls) exec.results.set(u, okResult(u, { output: "summary", costUsd: 0.0005 }));
  const res = await makeBulk(exec, fakeClock(), { maxConcurrency: 2 }).execute({ urls, output: "summary", maxTransformCostUsd: 0.002 });
  const downgraded = res.results.filter((r) => r.output === "raw");
  assert.ok(downgraded.length >= 1, "≥1 seed downgraded to raw once the cost cap bit");
  for (const r of downgraded) {
    assert.equal(r.status, "partial", "a downgraded seed is partial, not pass");
    assert.ok(r.warnings.some((w) => w.code === "transform_skipped_cost_cap"), "downgraded seed carries the warning");
  }
});

test("bulk: a summary seed whose transform fell back to raw reports the SETTLED output (raw), not the request", async () => {
  const exec = new FakeExecutor();
  const fallback: Result = {
    ...okResult("https://a.test/x"),
    output: "raw",
    transform: { provider: "none", reason: "unconfigured" },
  };
  exec.results.set("https://a.test/x", fallback);
  const res = await makeBulk(exec).execute({ urls: ["https://a.test/x"], output: "summary" });
  assert.equal(res.count, 1);
  assert.equal(res.results[0].output, "raw", "settled output (raw fallback), not the requested summary");
  assert.equal(res.results[0].status, "partial");
});

test("bulk cost serialize: concurrent transforms are serialized so the cap re-check gates each (overshoot ≤ 1 oversize seed)", async () => {
  const exec = new FakeExecutor();
  const urls = Array.from({ length: 4 }, (_, i) => `https://h${i}.test/p${i}`);
  for (const u of urls) exec.results.set(u, okResult(u, { output: "summary", costUsd: 0.11 }));
  // maxConcurrency 4 (all could dispatch concurrently), maxTransformCostUsd 0.10, each transform
  // actually $0.11. Without serialization 4 would run concurrently (4×0.11 = $0.44) before the
  // post-transform re-check. Serializing (transform cap 1) lets 1 run (breaches), and the rest,
  // blocked on the slot, re-check the cap and fail-soft to raw. Spend bounded to ~1 oversize.
  const res = await makeBulk(exec, fakeClock(), { maxConcurrency: 4 }).execute({ urls, output: "summary", maxTransformCostUsd: 0.10 });
  assert.ok(res.totals.transformCostUsd <= 0.11 + 1e-9, `cost overshoot bounded to ~1 oversize seed; got ${res.totals.transformCostUsd}`);
  assert.equal(res.results.filter((r) => r.output === "summary").length, 1, "exactly 1 transform before the cap re-check gated the rest");
});

test("bulk cost: a transform landing EXACTLY at the cap blocks queued transforms (costCapReached)", async () => {
  const exec = new FakeExecutor();
  const urls = Array.from({ length: 4 }, (_, i) => `https://h${i}.test/p${i}`);
  for (const u of urls) exec.results.set(u, okResult(u, { output: "summary", costUsd: 0.10 }));
  // Each transform costs exactly the $0.10 cap. The first lands at costSettled=0.10 (not > 0.10,
  // so no shortCircuit), but costCapReached makes the queued seeds fail-soft to raw.
  const res = await makeBulk(exec, fakeClock(), { maxConcurrency: 4 }).execute({ urls, output: "summary", maxTransformCostUsd: 0.10 });
  assert.equal(res.results.filter((r) => r.output === "summary").length, 1, "only the first transform runs (lands exactly at the cap)");
  assert.equal(res.results.filter((r) => r.output === "raw").length, 3, "queued seeds fail-soft to raw once the cap is reached");
});

test("bulk cost: an oversize transform UNDER the cap still blocks queued seeds (settled + reserved check)", async () => {
  const exec = new FakeExecutor();
  const urls = Array.from({ length: 4 }, (_, i) => `https://h${i}.test/p${i}`);
  for (const u of urls) exec.results.set(u, okResult(u, { output: "summary", costUsd: 0.08 })); // oversize vs perSeed 0.025, under cap 0.10
  // seed 1 transforms ($0.08, oversize). The 3 queued reservations (3×0.025=$0.075) + settled $0.08
  // = $0.155 > cap → costCapReached (settled+reserved) fail-softs the queued seeds. Spend bounded
  // to the 1 oversize seed (was: costCapReached checked settled only → queued seeds ran → ~$0.16+).
  const res = await makeBulk(exec, fakeClock(), { maxConcurrency: 4 }).execute({ urls, output: "summary", maxTransformCostUsd: 0.10 });
  assert.equal(res.results.filter((r) => r.output === "summary").length, 1, "only the first (oversize) transform runs");
  assert.ok(res.totals.transformCostUsd <= 0.08 + 1e-9, `spend bounded to the 1 oversize seed; got ${res.totals.transformCostUsd}`);
});

test("raceWallAbort: an aborted wall signal abandons a slow in-flight transform (dispatch-level)", async () => {
  const ac = new AbortController();
  ac.abort();
  // a "slow" transform that never resolves on its own — the race must abandon it on the wall signal
  const slow = new Promise<Result>(() => {});
  const res = await raceWallAbort(slow, ac.signal, { url: "https://a.test/x" });
  assert.equal(res.tier, "error");
  assert.equal(res.errors[0]?.code, "bulk_deadline_exceeded");
  assert.equal(res.resolvedVia, "bulk-wall-abandon");
});

test("bulk: a redirect-funnel to a FAILING victim is still counted (redirects preserved on reject)", async () => {
  // Each seed 302s to victim.test, which then times out → a tier:error result whose redirects
  // (the 302 to victim) are PRESERVED, so the union count sees the victim + the quarantine fires.
  const exec = new FakeExecutor();
  const urls = Array.from({ length: 14 }, (_, i) => `https://src${i}.test/p`);
  for (const u of urls) exec.results.set(u, { ...rejectResult(u, "timeout", "timed out"), redirects: [{ url: "https://victim.test/x", status: 302 }] });
  const res = await makeBulk(exec, fakeClock(), { maxPerHostInflight: 50, maxConcurrency: 4 }).execute({ urls });
  assert.ok(res.capBreaches.some((c) => c.startsWith("bulk_per_host_cap")), `failing-redirect victim counted + quarantined: ${res.capBreaches}`);
  assert.ok(res.results.some((r) => r.codeText === "bulk_per_host_cap"), "some funnel seeds aborted after the victim crossed the cap");
});

test("bulk: a seed wall-aborted while waiting for the transform slot is bulk_deadline_exceeded (not a raw re-run)", async () => {
  // seed 1 acquires the (cap-1) transform slot + blocks in execute (never resolves). seed 2 waits
  // on the slot; the wall (maxGlobalWallMs=1) fires during that wait → acquire returns false →
  // bulk_deadline_exceeded (NOT a raw downgrade that re-runs against an aborted signal → "timeout").
  const exec = new FakeExecutor();
  exec.results.set("https://a.test/block", okResult("https://a.test/block", { output: "summary" }));
  exec.results.set("https://b.test/x", okResult("https://b.test/x", { output: "summary" }));
  const realExec = exec.execute.bind(exec);
  exec.execute = async (input: unknown, ctx?: CaptatumContext) => input && typeof input === "object" && (input as { url: string }).url.endsWith("/block")
    ? new Promise<Result>(() => {}) // never resolves — holds the transform slot
    : realExec(input, ctx);
  const res = await makeBulk(exec, fakeClock(), { maxConcurrency: 2, maxGlobalWallMs: 1 }).execute({ urls: ["https://a.test/block", "https://b.test/x"], output: "summary" });
  const seed2 = res.results.find((r) => r.url.includes("b.test"));
  assert.ok(seed2, "seed 2 present");
  assert.equal(seed2!.codeText, "bulk_deadline_exceeded", "the slot-waiting seed is deadline-marked, not a raw re-run/timeout");
});

test("bulk: a wall breach DURING an in-flight transform is recorded in capBreaches", async () => {
  // A summary seed whose transform never resolves: raceWallAbort abandons it at the wall, but the
  // result flows through afterSeed (not a record branch) — so the in-flight breach must be recorded
  // after the await for the receipt/audit disclosure.
  const exec = new FakeExecutor();
  exec.results.set("https://a.test/x", okResult("https://a.test/x", { output: "summary" }));
  exec.execute = async () => new Promise<Result>(() => {}); // transform never resolves
  const res = await makeBulk(exec, fakeClock(), { maxConcurrency: 1, maxGlobalWallMs: 1 }).execute({ urls: ["https://a.test/x"], output: "summary" });
  assert.ok(res.capBreaches.includes("bulk_deadline_exceeded"), "in-flight wall breach recorded in capBreaches");
});

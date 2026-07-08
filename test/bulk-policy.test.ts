import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BULK_GUARD_CEILINGS,
  BULK_GUARD_DEFAULTS,
  applyPerHostCap,
  applyTotalClamp,
  classifyBulkStatus,
  dedupeSeeds,
  generateFenceToken,
  seedRegistrableKey,
  shapeBulkInput,
  unionEgressHosts,
  type ValidatedSeed,
} from "../src/domain/bulk-policy.ts";
import { resolveBulkGuard } from "../src/domain/bulk-config.ts";

const seed = (url: string): ValidatedSeed => ({ url });

test("dedupeSeeds: drops duplicates, preserves first-seen order", () => {
  const out = dedupeSeeds([
    seed("https://a.com/1"),
    seed("https://a.com/1"), // dup
    seed("https://a.com/2"),
    seed("https://a.com/1"), // dup
  ]);
  assert.equal(out.seeds.length, 2);
  assert.equal(out.dropped, 2);
  assert.deepEqual(out.seeds.map((s) => s.url), ["https://a.com/1", "https://a.com/2"]);
});

test("applyPerHostCap: truncates a host over the cap, keeps siblings, discloses", () => {
  const seeds = [
    ...Array.from({ length: 12 }, (_, i) => seed(`https://victim.com/j${i}`)),
    seed("https://other.com/x"),
    seed("https://other.com/y"),
  ];
  const out = applyPerHostCap(seeds, 10);
  // victim capped at 10 (2 dropped), other fully kept (2)
  assert.equal(out.seeds.filter((s) => s.url.includes("victim.com")).length, 10);
  assert.equal(out.seeds.filter((s) => s.url.includes("other.com")).length, 2);
  assert.equal(out.truncated.length, 1);
  assert.deepEqual(out.truncated[0], { host: "victim.com", kept: 10, dropped: 2 });
});

test("applyPerHostCap: multi-tenant suffixes are distinct buckets (github.io)", () => {
  // The PSL-critical guard: foo.github.io and bar.github.io are DIFFERENT hosts,
  // so neither is unfairly truncated when the other floods. (tldts would collapse them.)
  const seeds = [
    ...Array.from({ length: 8 }, (_, i) => seed(`https://foo.github.io/p${i}`)),
    ...Array.from({ length: 8 }, (_, i) => seed(`https://bar.github.io/p${i}`)),
  ];
  const out = applyPerHostCap(seeds, 10);
  assert.equal(out.seeds.filter((s) => s.url.includes("foo.github.io")).length, 8);
  assert.equal(out.seeds.filter((s) => s.url.includes("bar.github.io")).length, 8);
  assert.equal(out.truncated.length, 0);
});

test("applyPerHostCap: IP-literal seeds key on the bare host (distinct IPs = distinct buckets)", () => {
  // IP literals have no registrable domain; each distinct IP is its own bucket
  // (no collapse), and localhost is its own bucket.
  const seeds = [
    seed("https://10.0.0.1/a"),
    seed("https://10.0.0.1/b"),
    seed("https://10.0.0.2/a"),
  ];
  const out = applyPerHostCap(seeds, 1);
  assert.equal(out.seeds.length, 2); // 10.0.0.1/a + 10.0.0.2/a (10.0.0.1/b dropped)
  assert.equal(out.truncated.length, 1);
  assert.equal(out.truncated[0].host, "10.0.0.1");
});

test("applyTotalClamp: clamps to maxUrls + discloses; under-cap = no clamp", () => {
  const big = Array.from({ length: 60 }, (_, i) => seed(`https://a.com/${i}`));
  const clamped = applyTotalClamp(big, 50);
  assert.equal(clamped.seeds.length, 50);
  assert.equal(clamped.clampedTo, 50);
  assert.deepEqual(clamped.seeds.slice(0, 2).map((s) => s.url), ["https://a.com/0", "https://a.com/1"]);

  const small = applyTotalClamp(big.slice(0, 5), 50);
  assert.equal(small.seeds.length, 5);
  assert.equal(small.clampedTo, null);
});

test("shapeBulkInput: pipeline order = dedupe → per-host cap → total clamp", () => {
  // victim.com: j0 ×3 (dups) + j1..j9 (9 distinct) = 12 RAW → 10 AFTER DEDUPE.
  //   If per-host cap ran BEFORE dedupe it would see 12 and truncate; the fact
  //   victim is NOT truncated proves dedupe runs first.
  // bad.com: 12 distinct → 12 after dedupe → cap 10, drop 2 (truncated).
  // 49 distinct single-host domains (h0..h48), 1 seed each.
  const seeds = [
    seed("https://victim.com/j0"), seed("https://victim.com/j0"), seed("https://victim.com/j0"),
    ...Array.from({ length: 9 }, (_, i) => seed(`https://victim.com/j${i + 1}`)),
    ...Array.from({ length: 12 }, (_, i) => seed(`https://bad.com/b${i}`)),
    ...Array.from({ length: 49 }, (_, i) => seed(`https://h${i}.com/x`)),
  ];
  const shaped = shapeBulkInput(seeds, BULK_GUARD_DEFAULTS);
  // dedupe: 73 raw → 71 (2 victim.com/j0 dups dropped)
  assert.equal(shaped.deduped, 2);
  // per-host cap: only bad.com exceeds 10 after dedupe (victim is exactly 10)
  assert.equal(shaped.perHostTruncated.length, 1);
  assert.equal(shaped.perHostTruncated[0].host, "bad.com");
  assert.equal(shaped.perHostTruncated[0].dropped, 2);
  // total: 10 (victim) + 10 (bad) + 49 = 69 → clamp 50
  assert.equal(shaped.totalClampedTo, 50);
  assert.equal(shaped.seeds.length, 50);
});

test("resolveBulkGuard: output=raw → maxUrls 50; output=summary → maxUrls 10", () => {
  const raw = resolveBulkGuard({ operator: {}, output: "raw" }).guard;
  assert.equal(raw.maxUrls, 50);
  const summary = resolveBulkGuard({ operator: {}, output: "summary" }).guard;
  assert.equal(summary.maxUrls, 10);
});

test("resolveBulkGuard: caller cost overrides clamp DOWN to the server ceiling + disclose", () => {
  // A LOWER caller global cap is honored (decision 9: "cap this bulk at $0.10").
  // The global itself is not clamped; perSeed concurrency-sizes to 0.10/4 = 0.025
  // (4 × 0.025 = 0.10 ≤ ceiling) and that sizing is disclosed.
  const lower = resolveBulkGuard({ operator: {}, output: "raw", caller: { maxTransformCostUsd: 0.1 } });
  assert.equal(lower.guard.maxTransformCostUsd, 0.1);
  assert.equal(lower.guard.perSeedTransformCostUsd, 0.025);
  assert.deepEqual(lower.clamped, ["perSeedTransformCostUsd"]);
  // An OVER-ceiling caller value is clamped to the ceiling + disclosed (never above).
  const over = resolveBulkGuard({ operator: {}, output: "raw", caller: { maxTransformCostUsd: 5, perSeedTransformCostUsd: 1 } });
  assert.equal(over.guard.maxTransformCostUsd, 0.5);
  assert.equal(over.guard.perSeedTransformCostUsd, 0.05);
  assert.ok(over.clamped.includes("maxTransformCostUsd"));
  assert.ok(over.clamped.includes("perSeedTransformCostUsd"));
});

test("resolveBulkGuard: crawlDelayMs floored at 500; per-host inflight floored at 1", () => {
  const g = resolveBulkGuard({ operator: { crawlDelayMs: 100, maxPerHostInflight: 0 }, output: "raw" }).guard;
  assert.equal(g.crawlDelayMs, 500);
  assert.equal(g.maxPerHostInflight, 1);
});

test("resolveBulkGuard: operator concurrency capped at the default (never wider)", () => {
  const g = resolveBulkGuard({ operator: { maxConcurrency: 99 }, output: "raw" }).guard;
  assert.equal(g.maxConcurrency, 4);
});

test("resolveBulkGuard: per-seed cost sized for concurrency (maxConcurrency × perSeed ≤ global)", () => {
  // The concurrent-overshoot bound (codex round-7): up to maxConcurrency transforms
  // run before the post-transform global re-check, so perSeed must be ≤
  // global/maxConcurrency or a caller's lower ceiling is blown by the first wave.
  // (1) Caller lowers only global to $0.01; default conc=4 → perSeed clamps to
  //     $0.0025 (4 × $0.0025 = $0.01 ≤ ceiling), disclosed.
  const out = resolveBulkGuard({ operator: {}, output: "raw", caller: { maxTransformCostUsd: 0.01 } });
  assert.equal(out.guard.maxTransformCostUsd, 0.01);
  assert.equal(out.guard.perSeedTransformCostUsd, 0.0025);
  assert.ok(out.clamped.includes("perSeedTransformCostUsd"));
  assert.ok(out.guard.maxConcurrency * out.guard.perSeedTransformCostUsd <= out.guard.maxTransformCostUsd + 1e-9, "C × perSeed ≤ global");
  // (2) A per-seed UNDER global/conc is honored unchanged.
  const out2 = resolveBulkGuard({ operator: {}, output: "raw", caller: { perSeedTransformCostUsd: 0.04 } });
  assert.equal(out2.guard.perSeedTransformCostUsd, 0.04); // 0.04 < 0.50/4 = 0.125
  assert.ok(!out2.clamped.includes("perSeedTransformCostUsd"));
  // (3) maxConcurrency=1 → reduces to perSeed ≤ global (no concurrent overshoot);
  //     a per-seed above the global clamps to the global.
  const out3 = resolveBulkGuard({ operator: { maxConcurrency: 1 }, output: "raw", caller: { maxTransformCostUsd: 0.03, perSeedTransformCostUsd: 0.04 } });
  assert.equal(out3.guard.perSeedTransformCostUsd, 0.03);
  assert.equal(out3.guard.maxTransformCostUsd, 0.03);
});

test("maxGlobalWallMs: hosted default 55s, ceiling 180s (local keeps the pre-#148 wall) (#148)", () => {
  // Teeth-check: the hosted DEFAULT MUST sit inside the documented MCP client tool-call window —
  // ~60 s for chatgpt.com's hosted connector (HTTP 424) and the Claude Code SDK
  // (DEFAULT_REQUEST_TIMEOUT_MSEC). A 180 s default (the old value) assembles a partial the client
  // never receives. If the default drifts back up without the client window widening, this fails.
  assert.equal(BULK_GUARD_DEFAULTS.maxGlobalWallMs, 55_000);
  assert.ok(BULK_GUARD_DEFAULTS.maxGlobalWallMs < 60_000, "hosted default must beat the ~60 s client floor");
  // The CEILING stays 180 s — the local-binary flavor (no client-side timeout, a patient stdio
  // client) keeps the pre-#148 wall via an operator override, so lowering the hosted default did
  // NOT narrow local (codex #156 P2). An operator may raise toward 180 s; never past it.
  assert.equal(BULK_GUARD_CEILINGS.maxGlobalWallMs, 180_000);
  assert.ok(BULK_GUARD_CEILINGS.maxGlobalWallMs > BULK_GUARD_DEFAULTS.maxGlobalWallMs, "ceiling > hosted default (local/patient deployments may raise)");
});

test("resolveBulkGuard: operator may set the wall in [1 ms, ceiling] — local raises, hosted defaults (#148)", () => {
  // An operator value UP TO the 180 s ceiling is HONORED — the local-binary flavor uses this to
  // keep its pre-#148 wall (local-server.ts passes BULK_GUARD_CEILINGS.maxGlobalWallMs), and a
  // hosted deployment may raise if it learns its real client timeout is higher.
  assert.equal(resolveBulkGuard({ operator: { maxGlobalWallMs: 100_000 }, output: "raw" }).guard.maxGlobalWallMs, 100_000);
  assert.equal(resolveBulkGuard({ operator: { maxGlobalWallMs: BULK_GUARD_CEILINGS.maxGlobalWallMs }, output: "raw" }).guard.maxGlobalWallMs, 180_000);
  // ABOVE the ceiling is clamped DOWN (the hard server cap; an operator may never exceed it).
  assert.equal(resolveBulkGuard({ operator: { maxGlobalWallMs: 300_000 }, output: "raw" }).guard.maxGlobalWallMs, BULK_GUARD_CEILINGS.maxGlobalWallMs);
  // BELOW the default is honored (tightening); ABSENT → the 55 s hosted default.
  assert.equal(resolveBulkGuard({ operator: { maxGlobalWallMs: 20_000 }, output: "raw" }).guard.maxGlobalWallMs, 20_000);
  assert.equal(resolveBulkGuard({ operator: {}, output: "raw" }).guard.maxGlobalWallMs, BULK_GUARD_DEFAULTS.maxGlobalWallMs);
  // The clamp floors at 1 ms (a degenerate-but-finite wall, exercised by the firing tests).
  assert.equal(resolveBulkGuard({ operator: { maxGlobalWallMs: 0 }, output: "raw" }).guard.maxGlobalWallMs, 1);
});

test("unionEgressHosts: seed + redirects + finalUrl; defeats the redirect-funnel attack", () => {
  // The cross-domain directed-DoS vector: a seed on site1.com 302→victim.com.
  // Keyed on the SEED host alone, victim is invisible; the union must include it.
  const hosts = unionEgressHosts({
    seedRegistrable: "site1.com",
    redirects: ["https://victim.com/lander"],
    finalUrl: "https://victim.com/page",
  });
  assert.ok(hosts.includes("site1.com"));
  assert.ok(hosts.includes("victim.com"), "the redirect/final victim host MUST be in the union");
});

test("unionEgressHosts: redirect-funnel aggregation — N distinct seed domains all funnelling to one victim", () => {
  // The orchestrator aggregates union hosts across seeds; this test proves the
  // helper surfaces victim.com for every funnelled seed, so a running count
  // would cap victim at maxPerHostInBulk across the whole call.
  const seeds = ["site1.com", "site2.com", "site3.com"];
  const victimCount = seeds.filter((sd) =>
    unionEgressHosts({ seedRegistrable: sd, redirects: ["https://victim.com/x"], finalUrl: "https://victim.com/x" })
      .includes("victim.com"),
  ).length;
  assert.equal(victimCount, 3, "all three distinct seed domains expose victim.com in their union");
});

test("unionEgressHosts: multi-tenant redirect hosts stay distinct (no github.io collapse)", () => {
  const hosts = unionEgressHosts({
    seedRegistrable: "app.com",
    redirects: ["https://foo.github.io/cdn", "https://bar.github.io/cdn"],
    finalUrl: "https://app.com/page",
  });
  assert.ok(hosts.includes("foo.github.io"));
  assert.ok(hosts.includes("bar.github.io"));
  assert.notEqual(hosts.find((h) => h === "github.io"), "github.io", "must NOT collapse to the bare suffix");
});

test("unionEgressHosts: IP-literal redirect/final victim IS counted (no drop on PSL-null)", () => {
  // The codex-caught directed-DoS gap: a redirect-funnel to a public IP victim.
  // registrableDomain("8.8.8.8") === null; the bare-host fallback must preserve
  // "8.8.8.8" so the per-host count/rate cap can bind it.
  const hosts = unionEgressHosts({
    seedRegistrable: "site1.com",
    redirects: ["https://8.8.8.8/lander"],
    finalUrl: "https://8.8.8.8/page",
  });
  assert.ok(hosts.includes("8.8.8.8"), "an IP-literal egress victim MUST be in the union (not dropped)");
  assert.ok(hosts.includes("site1.com"));
  // distinct IP victims stay distinct buckets
  const two = unionEgressHosts({ seedRegistrable: "a.com", redirects: ["https://8.8.8.8/x", "https://8.8.4.4/x"], finalUrl: "https://a.com/" });
  assert.ok(two.includes("8.8.8.8"));
  assert.ok(two.includes("8.8.4.4"));
});

test("classifyBulkStatus: pass / partial / fail / empty", () => {
  assert.equal(classifyBulkStatus(["pass", "pass"]), "pass");
  assert.equal(classifyBulkStatus(["pass", "fail"]), "partial");
  assert.equal(classifyBulkStatus(["fail", "fail"]), "fail");
  assert.equal(classifyBulkStatus(["partial"]), "partial");
  assert.equal(classifyBulkStatus([]), "fail", "empty = fail (no seeds processed)");
});

test("seedRegistrableKey: co.uk siblings share; github.io tenants differ; IP = host", () => {
  assert.equal(seedRegistrableKey(seed("https://a.example.co.uk/x")), "example.co.uk");
  assert.equal(seedRegistrableKey(seed("https://b.example.co.uk/y")), "example.co.uk");
  assert.notEqual(
    seedRegistrableKey(seed("https://foo.github.io/x")),
    seedRegistrableKey(seed("https://bar.github.io/x")),
  );
  assert.equal(seedRegistrableKey(seed("https://10.0.0.1/x")), "10.0.0.1");
});

test("generateFenceToken: 16 hex chars, unique across calls (unforgeable by page content)", () => {
  const t1 = generateFenceToken();
  const t2 = generateFenceToken();
  assert.equal(t1.length, 16);
  assert.equal(t2.length, 16);
  assert.match(t1, /^[0-9a-f]{16}$/);
  assert.notEqual(t1, t2, "CSPRNG tokens must collide-resist across calls");
});

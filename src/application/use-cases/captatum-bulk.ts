// captatum_bulk orchestrator — runs N independent single-URL captatum calls under the
// BulkGuard caps. It adds NO egress path: it composes the (UNWRAPPED) executor per seed,
// so every per-seed SSRF / prompt-injection control is enforced unchanged. Amplification
// is fixed at 1 per caller URL (no discovery/recursion/depth). The bounds (docs/contracts.md
// §"Tool: captatum_bulk"): a global `maxConcurrency` pool + a union-keyed per-host COUNT cap
// (`maxPerHostInBulk`, the directed-DoS bound) + a per-host RATE gate (`maxPerHostInflight`
// burst + `crawlDelayMs`) + a BudgetTracker (egress bytes + transform cost, dispatch-time
// reservation + post-transform re-check) + a global wall AbortController threaded into each
// seed's fetch via CaptatumContext.signal. Partial failure is NORMAL; whole-call fails only
// on input-validation (normalizeBulkInput throws) / auth / admission OverloadedError.
import { randomUUID } from "node:crypto";
import type { ClockPort } from "../ports/clock.ts";
import type { CaptatumContext } from "../ports/captatum-context.ts";
import type { CaptatumExecutorPort } from "../ports/captatum-executor.ts";
import type { PlatformAdapterRegistry } from "../ports/platform-adapter.ts";
import { registrableDomain } from "../../domain/registrable-domain.ts";
import {
  classifyBulkStatus,
  generateFenceToken,
  seedRegistrableKey,
  shapeBulkInput,
  unionEgressHosts,
  type BulkGuard,
  type ValidatedSeed,
} from "../../domain/bulk-policy.ts";
import { resolveBulkGuard, type BulkOperatorConfig } from "../../domain/bulk-config.ts";
import {
  type BulkClamp,
  type BulkFailure,
  type BulkResult,
  type BulkSeedResult,
  type BulkTotals,
} from "../../domain/bulk-result.ts";
import type { Output } from "../../domain/tier.ts";
import type { Platform } from "../../domain/platform.ts";
import type { Result } from "../../domain/result.ts";
import { normalizeBulkInput, type NormalizedBulkRequest } from "./bulk-input.ts";
import { BudgetTracker, type BudgetCapReason } from "./bulk-budget.ts";
import { PerHostGate, Semaphore } from "./bulk-concurrency.ts";
import { abortedSeedResult, hostOf, toBulkSeedResult } from "./bulk-seed.ts";

const GENERIC_PLATFORM: Platform = { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier1" };

export interface CaptatumBulkDeps {
  /** UNWRAPPED executor — per-seed fan-out takes NO admission slots (the bulk CALL holds
   *  the one slot). Bounded by the BulkGuard, not the admission limiter. */
  executor: CaptatumExecutorPort;
  adapters: PlatformAdapterRegistry;
  clock: ClockPort;
  operator: Partial<BulkOperatorConfig>;
}

interface ShortCircuit { code: string; message: string; }

export class CaptatumBulkUseCase {
  private readonly deps: CaptatumBulkDeps;
  constructor(deps: CaptatumBulkDeps) {
    this.deps = deps;
  }

  async execute(input: unknown, context: CaptatumContext = {}): Promise<BulkResult> {
    const startMs = this.deps.clock.nowMs();
    const normalized = normalizeBulkInput(input); // throws CaptatumInputError → tool-level error
    const { guard, clamped: costClamped } = resolveBulkGuard({
      operator: this.deps.operator,
      output: normalized.request.requestedOutput,
      caller: {
        ...(normalized.request.maxTransformCostUsd !== undefined ? { maxTransformCostUsd: normalized.request.maxTransformCostUsd } : {}),
        ...(normalized.request.perSeedTransformCostUsd !== undefined ? { perSeedTransformCostUsd: normalized.request.perSeedTransformCostUsd } : {}),
      },
    });
    const { toProcess, boardRejected } = this.rejectBoards(normalized.seeds);
    const shaped = shapeBulkInput(toProcess, guard);
    const wallController = new AbortController();
    const wallTimer = setTimeout(() => wallController.abort(), guard.maxGlobalWallMs);
    let ran: { results: BulkSeedResult[]; capBreaches: string[]; budget: BudgetTracker };
    try {
      ran = await this.runPool(shaped.seeds, normalized.request, guard, wallController, context);
    } finally {
      clearTimeout(wallTimer);
    }
    return this.assemble(`bulk-${randomUUID()}`, generateFenceToken(), guard, costClamped, shaped, toProcess.length, ran, normalized, boardRejected, startMs);
  }

  /** Reject Tier-2 board-root seeds per-entry (roster-intact invariant). Per-JD URLs are
   *  NOT detected (the adapters claim only board roots) and flow through to Tier-1. */
  private rejectBoards(seeds: readonly ValidatedSeed[]): { toProcess: ValidatedSeed[]; boardRejected: ValidatedSeed[] } {
    const toProcess: ValidatedSeed[] = [];
    const boardRejected: ValidatedSeed[] = [];
    for (const s of seeds) (this.deps.adapters.detect({ url: s.url }) ? boardRejected : toProcess).push(s);
    return { toProcess, boardRejected };
  }

  private async runPool(
    seeds: readonly ValidatedSeed[],
    request: NormalizedBulkRequest,
    guard: BulkGuard,
    wallController: AbortController,
    context: CaptatumContext,
  ): Promise<{ results: BulkSeedResult[]; capBreaches: string[]; budget: BudgetTracker }> {
    const results = new Array<BulkSeedResult>(seeds.length);
    const budget = new BudgetTracker({
      clock: this.deps.clock, maxGlobalEgressBytes: guard.maxGlobalEgressBytes, maxGlobalWallMs: guard.maxGlobalWallMs,
      maxTransformCostUsd: guard.maxTransformCostUsd, perSeedTransformCostUsd: guard.perSeedTransformCostUsd, perSeedMaxBytes: request.maxBytes,
    });
    const sem = new Semaphore(guard.maxConcurrency);
    const gate = new PerHostGate(guard.maxPerHostInflight, guard.crawlDelayMs, this.deps.clock);
    const hostCounts = new Map<string, number>();
    const capBreaches: string[] = [];
    const signal = wallController.signal;
    let shortCircuit: ShortCircuit | null = null;
    const record = (code: string): void => { if (!capBreaches.includes(code)) capBreaches.push(code); };

    await Promise.all(seeds.map(async (seed, idx) => {
      const acquired = await sem.acquire(signal);
      if (!acquired) { results[idx] = abortedSeedResult(seed, "bulk_deadline_exceeded", "wall deadline reached"); return; }
      try {
        if (shortCircuit || signal.aborted || budget.wallExceeded()) {
          const wall = signal.aborted || budget.wallExceeded();
          results[idx] = abortedSeedResult(seed, wall ? "bulk_deadline_exceeded" : shortCircuit!.code, wall ? "wall deadline reached" : shortCircuit!.message);
          return;
        }
        const seedKey = seedRegistrableKey(seed);
        if ((hostCounts.get(seedKey) ?? 0) >= guard.maxPerHostInBulk) {
          record("bulk_per_host_cap");
          results[idx] = abortedSeedResult(seed, "bulk_per_host_cap", `per-host cap (${guard.maxPerHostInBulk}) reached for ${seedKey}`);
          return;
        }
        await gate.acquire(seedKey, signal);
        try {
          // Re-check the wall after the (possibly-blocking) rate-gate wait: the deadline may
          // have fired mid-acquire, and without this the seed would run with an aborted signal
          // (fail "timeout") instead of the honest bulk_deadline_exceeded.
          if (signal.aborted || budget.wallExceeded()) {
            results[idx] = abortedSeedResult(seed, "bulk_deadline_exceeded", "wall deadline reached");
            return;
          }
          const before = budget.beforeSeed();
          if (!before.dispatch) {
            shortCircuit = shortCircuit ?? budgetMsg(before.reason as BudgetCapReason);
            record(`bulk_budget_exceeded:${before.reason}`);
            results[idx] = abortedSeedResult(seed, "bulk_budget_exceeded", `budget cap reached (${before.reason})`);
            return;
          }
          const effectiveOutput: Output = request.requestedOutput !== "raw" && before.runTransform ? request.requestedOutput : "raw";
          let seedResult: Result;
          try {
            seedResult = await this.deps.executor.execute(
              { url: seed.url, prompt: request.prompt, output: effectiveOutput, schema: request.schema, budget: request.budget, transform: request.transform, maxBytes: request.maxBytes, timeoutMs: request.timeoutMs, allowRender: false, debug: request.debug },
              { ...(context.fetchedAt !== undefined ? { fetchedAt: context.fetchedAt } : {}), signal },
            );
          } catch (err) {
            seedResult = syntheticFail(seed, err);
          }
          // transformReserved mirrors before.runTransform (the exact predicate beforeSeed reserved
          // under) so the cost reservation is always released on the seed it was taken for — never
          // the output-derived proxy (which diverges on a raw request with runTransform true).
          const after = budget.afterSeed({ bytes: seedResult.bytes, costUsd: seedResult.transform?.costUsd, inTokens: seedResult.transform?.inTokens, outTokens: seedResult.transform?.outTokens, transformReserved: before.runTransform });
          if (after.shortCircuit) {
            shortCircuit = shortCircuit ?? budgetMsg(after.reason as BudgetCapReason);
            record(`bulk_budget_exceeded:${after.reason}`);
          }
          // Post-settle union-egress-host count — the cross-domain directed-DoS accounting.
          // A victim discovered via redirect is counted here (disclosed in capBreaches); the
          // pre-egress seed-domain check cannot see it (the documented discovery overshoot).
          for (const h of unionEgressHosts({ seedRegistrable: registrableDomain(hostOf(seed.url)) ?? hostOf(seed.url), redirects: seedResult.redirects.map((r) => r.url), finalUrl: seedResult.finalUrl })) {
            const next = (hostCounts.get(h) ?? 0) + 1;
            hostCounts.set(h, next);
            if (next > guard.maxPerHostInBulk) record(`bulk_per_host_cap:${h}`);
          }
          results[idx] = toBulkSeedResult(seed, seedResult, effectiveOutput);
        } finally {
          gate.release(seedKey);
        }
      } finally {
        sem.release();
      }
    }));
    return { results, capBreaches, budget };
  }

  private assemble(
    bulkId: string, fenceToken: string, guard: BulkGuard, costClamped: string[], shaped: ReturnType<typeof shapeBulkInput>,
    toProcessCount: number, ran: { results: BulkSeedResult[]; capBreaches: string[]; budget: BudgetTracker },
    normalized: { invalid: { url: string; code: string; message: string }[] }, boardRejected: ValidatedSeed[], startMs: number,
  ): BulkResult {
    const { results, capBreaches, budget } = ran;
    const failedSeeds = results.filter((r) => r.status === "fail");
    const failures: BulkFailure[] = [
      ...normalized.invalid.map((f) => ({ url: f.url, code: f.code, message: f.message })),
      ...boardRejected.map((s) => ({ url: s.url, code: "tier2_board_not_supported_in_bulk", message: "Tier-2 board-root seeds are rejected per-entry — single-fetch the board roster, then bulk the per-JD URLs." })),
      ...failedSeeds.map((r) => ({ url: r.url, code: failureCode(r), message: r.result })),
    ];
    const perHostDropped = shaped.perHostTruncated.reduce((n, t) => n + t.dropped, 0);
    const clamp: BulkClamp = {
      inputUrls: toProcessCount,
      afterDedupe: toProcessCount - shaped.deduped,
      afterPerHostCap: toProcessCount - shaped.deduped - perHostDropped,
      processed: results.length,
      perHostTruncated: shaped.perHostTruncated,
      totalClampedTo: shaped.totalClampedTo,
    };
    const totals: BulkTotals = {
      bytes: results.reduce((n, r) => n + r.bytes, 0),
      egressBytes: results.reduce((n, r) => n + r.egressBytes, 0),
      durationMs: Math.max(0, Math.round(this.deps.clock.nowMs() - startMs)),
      transformInTokens: budget.transformInTokens,
      transformOutTokens: budget.transformOutTokens,
      transformCostUsd: Math.round(budget.costUsed * 1e6) / 1e6,
    };
    const status = classifyBulkStatus(results.map((r) => r.status));
    return {
      schemaVersion: 1, kind: "bulk", bulkId, ok: status !== "fail", status,
      count: results.length, passed: results.length - failedSeeds.length, failed: failedSeeds.length,
      truncated: perHostDropped, deduped: shaped.deduped, totals, guard, capBreaches, clamp, fenceToken,
      results, failures,
      warnings: costClamped.map((c) => ({ code: "bulk_cost_clamped", message: `${c} was clamped to the server ceiling` })),
      errors: [],
    };
  }
}

function budgetMsg(reason: BudgetCapReason): ShortCircuit { return { code: "bulk_budget_exceeded", message: `bulk_budget_exceeded:${reason}` }; }

export function createCaptatumBulkUseCase(deps: CaptatumBulkDeps): CaptatumBulkUseCase {
  return new CaptatumBulkUseCase(deps);
}

function failureCode(r: BulkSeedResult): string {
  if (r.resolvedVia === "bulk-shortcut") return r.codeText; // a bulk_* short-circuit code
  if (r.tier === "error") return r.errors[0]?.code ?? "fetch_error";
  return `http_${r.code}`;
}

/** A per-seed Result for an executor throw (unexpected — partial failure is normal, so the
 *  seed is marked tier:error fail, never propagated to a whole-call error). */
function syntheticFail(seed: ValidatedSeed, err: unknown): Result {
  const message = err instanceof Error ? err.message : String(err);
  return {
    url: seed.url, bytes: 0, code: 0, codeText: "SEED_ERROR", durationMs: 0, result: message,
    schemaVersion: 1, finalUrl: seed.url, redirects: [], tier: "error", output: "raw",
    platform: GENERIC_PLATFORM, jsRequired: false, resolvedVia: "seed-error", attempts: [],
    contentType: "", timings: { totalMs: 0, fetchMs: 0 }, errors: [{ code: "seed_error", message }],
  };
}

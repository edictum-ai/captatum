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
  generateFenceToken,
  seedRegistrableKey,
  shapeBulkInput,
  unionEgressHosts,
  type BulkGuard,
  type ValidatedSeed,
} from "../../domain/bulk-policy.ts";
import { resolveBulkGuard, type BulkOperatorConfig } from "../../domain/bulk-config.ts";
import { type BulkResult, type BulkSeedResult } from "../../domain/bulk-result.ts";
import type { Output } from "../../domain/tier.ts";
import type { Result } from "../../domain/result.ts";
import { normalizeBulkInput, type NormalizedBulkRequest } from "./bulk-input.ts";
import { BudgetTracker, type BudgetCapReason } from "./bulk-budget.ts";
import { PerHostGate, Semaphore } from "./bulk-concurrency.ts";
import { abortedSeedResult, hostOf, raceWallAbort, syntheticFail, toBulkSeedResult } from "./bulk-seed.ts";
import { assembleBulkResult } from "./bulk-assemble.ts";

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
    const { toProcess, boardRejected, ashbyRejected } = this.rejectPerEntry(normalized.seeds);
    const shaped = shapeBulkInput(toProcess, guard);
    const wallController = new AbortController();
    const wallTimer = setTimeout(() => wallController.abort(), guard.maxGlobalWallMs);
    let ran: { results: BulkSeedResult[]; capBreaches: string[]; budget: BudgetTracker };
    try {
      ran = await this.runPool(shaped.seeds, normalized.request, guard, wallController, context);
    } finally {
      clearTimeout(wallTimer);
    }
    return assembleBulkResult({
      bulkId: `bulk-${randomUUID()}`, fenceToken: generateFenceToken(), guard, costClamped, shaped, toProcessCount: toProcess.length,
      ran, normalized, boardRejected, ashbyRejected, startMs, clock: this.deps.clock,
    });
  }

  /** Per-entry rejection (roster-intact + egress-accounting invariants):
   *  - Tier-2 board-root seeds (roster expander → forbidden in bulk — single-fetch the board).
   *  - Ashby-embed (`?ashby_jid=`) seeds: the embed resolver performs an auxiliary host-page
   *    fetch NOT captured by v1's result.bytes egress accounting (BULK-5), so a caller adding
   *    ashby_jid to many URLs could spend up to another maxBytes/seed off the books. v1 closes
   *    this structurally (like render) — single-fetch embeds, or bulk the direct ashby job URLs.
   *  Per-JD URLs are not detected and flow through to Tier-1. */
  private rejectPerEntry(seeds: readonly ValidatedSeed[]): { toProcess: ValidatedSeed[]; boardRejected: ValidatedSeed[]; ashbyRejected: ValidatedSeed[] } {
    const toProcess: ValidatedSeed[] = [];
    const boardRejected: ValidatedSeed[] = [];
    const ashbyRejected: ValidatedSeed[] = [];
    for (const s of seeds) {
      if (this.deps.adapters.detect({ url: s.url })) boardRejected.push(s);
      else if (ashbyJidOf(s.url) !== null) ashbyRejected.push(s);
      else toProcess.push(s);
    }
    return { toProcess, boardRejected, ashbyRejected };
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
    const transformSem = new Semaphore(1); // serialize transforms (cost-cap honesty — see below)
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
          let effectiveOutput: Output = request.requestedOutput !== "raw" && before.runTransform ? request.requestedOutput : "raw";
          // Serialize transforms (cap 1): the transform INPUT is unbounded, so one seed's actual cost
          // can exceed perSeed; serializing lets the post-transform re-check gate each (overshoot ≤ 1
          // oversize). After acquiring the slot: a wall-abort (acquire false) → bulk_deadline_exceeded;
          // shortCircuit/costCapReached (cap reached/breached while waiting) → fail-soft to raw.
          let transformSlotHeld = false;
          if (effectiveOutput !== "raw") {
            transformSlotHeld = await transformSem.acquire(signal);
            if (!transformSlotHeld) {
              results[idx] = abortedSeedResult(seed, "bulk_deadline_exceeded", "wall deadline reached");
              return;
            }
            if (shortCircuit || budget.costCapReached()) {
              transformSem.release();
              transformSlotHeld = false;
              effectiveOutput = "raw";
            }
          }
          const downgradedByCost = request.requestedOutput !== "raw" && effectiveOutput === "raw";
          const execInput = { url: seed.url, prompt: request.prompt, output: effectiveOutput, schema: request.schema, budget: request.budget, transform: request.transform, maxBytes: request.maxBytes, timeoutMs: request.timeoutMs, allowRender: false, debug: request.debug };
          const execCtx = { ...(context.fetchedAt !== undefined ? { fetchedAt: context.fetchedAt } : {}), signal };
          let seedResult: Result;
          try {
            // A raw seed's fetch already aborts on the wall signal; a TRANSFORM seed's LLM call
            // does not — race it so the wall abandons a slow transform (dispatch-level, v1)
            // instead of holding the bulk open past 180s. The LLM call isn't canceled, only un-awaited.
            seedResult = transformSlotHeld
              ? await raceWallAbort(this.deps.executor.execute(execInput, execCtx), signal, seed)
              : await this.deps.executor.execute(execInput, execCtx);
          } catch (err) {
            seedResult = syntheticFail(seed, err);
          } finally {
            if (transformSlotHeld) transformSem.release();
          }
          // transformReserved mirrors before.runTransform (the exact predicate beforeSeed reserved
          // under) so the cost reservation is always released on the seed it was taken for — never
          // the output-derived proxy (which diverges on a raw request with runTransform true).
          const after = budget.afterSeed({ bytes: seedResult.bytes, costUsd: seedResult.transform?.costUsd, inTokens: seedResult.transform?.inTokens, outTokens: seedResult.transform?.outTokens, transformReserved: before.runTransform });
          if (after.shortCircuit) {
            shortCircuit = shortCircuit ?? budgetMsg(after.reason as BudgetCapReason);
            record(`bulk_budget_exceeded:${after.reason}`);
          }
          // Post-settle union-egress-host count. The pre-egress seed-domain check can't see a
          // fresh-domain funnel seed, so once a REDIRECT-discovered victim (h !== seedKey) crosses
          // the cap we QUARANTINE: stop dispatching the rest (bounds per-victim seeds; in-flight finish).
          for (const h of unionEgressHosts({ seedRegistrable: registrableDomain(hostOf(seed.url)) ?? hostOf(seed.url), redirects: seedResult.redirects.map((r) => r.url), finalUrl: seedResult.finalUrl })) {
            const next = (hostCounts.get(h) ?? 0) + 1;
            hostCounts.set(h, next);
            if (next > guard.maxPerHostInBulk) record(`bulk_per_host_cap:${h}`);
            if (h !== seedKey && next >= guard.maxPerHostInBulk && !shortCircuit) {
              shortCircuit = { code: "bulk_per_host_cap", message: `discovered redirect victim ${h} reached the per-bulk cap — remaining seeds aborted` };
              record("bulk_per_host_cap");
            }
          }
          // Use the SETTLED Result.output (a summary/extract seed that fell back to raw reports
          // raw); a cost-cap downgrade is surfaced as partial + a warning on an otherwise-passing seed.
          const row = toBulkSeedResult(seed, seedResult, seedResult.output);
          if (downgradedByCost && row.status === "pass") {
            row.status = "partial";
            row.warnings.push({ code: "transform_skipped_cost_cap", message: "Requested summary/extract ran as raw — the per-call transform cost cap was reached." });
          }
          results[idx] = row;
        } finally {
          gate.release(seedKey);
        }
      } finally {
        sem.release();
      }
    }));
    return { results, capBreaches, budget };
  }
}

function budgetMsg(reason: BudgetCapReason): ShortCircuit { return { code: "bulk_budget_exceeded", message: `bulk_budget_exceeded:${reason}` }; }

/** Inline mirror of the Ashby-embed jid extractor (kept here to avoid an application→
 *  infrastructure import; pure URL parsing). Non-null ⇒ an ashby-embed seed. */
function ashbyJidOf(url: string): string | null {
  try { return new URL(url).searchParams.get("ashby_jid"); } catch { return null; }
}

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


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
import type { BulkQuotaPort } from "../ports/bulk-quota.ts";
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
import { ashbyJidOf, rejectPerEntryBulk, reserveBulkQuota } from "./bulk-dispatch.ts";
import { BudgetTracker, RENDER_EGRESS_MULTIPLIER, type BudgetCapReason } from "./bulk-budget.ts";
import { PerHostGate, Semaphore } from "./bulk-concurrency.ts";
import { mergeRenderEgressHosts } from "./bulk-render.ts";
import { executeSeedWithRetry } from "./bulk-retry.ts";
import { abortedSeedResult, hostOf, raceWallAbort, syntheticFail, toBulkSeedResult } from "./bulk-seed.ts";
import { assembleBulkResult } from "./bulk-assemble.ts";

export interface CaptatumBulkDeps {
  /** UNWRAPPED executor — per-seed fan-out takes NO admission slots (the bulk CALL holds
   *  the one slot). Bounded by the BulkGuard, not the admission limiter. */
  executor: CaptatumExecutorPort;
  adapters: PlatformAdapterRegistry;
  clock: ClockPort;
  operator: Partial<BulkOperatorConfig>;
  /** Per-tenant seed-window quota (BULK-1). When present, each call reserves its
   *  processed-seed count against the calling tenant's window before dispatch; a
   *  refusal throws BulkQuotaError (fail-closed). Absent on the local-binary flavor. */
  quota?: BulkQuotaPort;
}

/** A run-level short-circuit. `hard` = true means a cap the FETCH itself would violate (egress
 *  bytes / per-host directed-DoS) → a queued seed must ABORT, not fail-soft to raw + execute.
 *  `hard` = false (transform-cost only) → the fetch is fine; fail-soft to raw (skip the LLM). */
interface ShortCircuit { code: string; message: string; hard: boolean; }

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
    const { toProcess, boardRejected, ashbyRejected } = rejectPerEntryBulk(this.deps.adapters, normalized.seeds);
    const shaped = shapeBulkInput(toProcess, guard);
    // Per-tenant seed-window quota (BULK-1): reserve the processed-seed count
    // BEFORE any dispatch. A refusal fails the WHOLE call (fail-closed). Skipped
    // when no quota port is configured (the local-binary flavor). The QuotaAllow is
    // carried onto the BulkResult so the per-tenant reservation is auditable.
    const quotaAllow = await reserveBulkQuota(this.deps.quota, context.clientId, shaped.seeds.length);
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
      ...(quotaAllow ? { quotaReserved: quotaAllow.reserved, quotaWindowSeconds: quotaAllow.windowSeconds, quotaLimit: quotaAllow.limit } : {}),
    });
  }

  private async runPool(
    seeds: readonly ValidatedSeed[],
    request: NormalizedBulkRequest,
    guard: BulkGuard,
    wallController: AbortController,
    context: CaptatumContext,
  ): Promise<{ results: BulkSeedResult[]; capBreaches: string[]; budget: BudgetTracker }> {
    const results = new Array<BulkSeedResult>(seeds.length);
    const budget = new BudgetTracker({ clock: this.deps.clock, maxGlobalEgressBytes: guard.maxGlobalEgressBytes, maxGlobalWallMs: guard.maxGlobalWallMs, maxTransformCostUsd: guard.maxTransformCostUsd, perSeedTransformCostUsd: guard.perSeedTransformCostUsd, perSeedMaxBytes: request.maxBytes });
    const sem = new Semaphore(guard.maxConcurrency);
    const transformSem = new Semaphore(1); // serialize transforms (cost-cap honesty)
    const gate = new PerHostGate(guard.maxPerHostInflight, guard.crawlDelayMs, this.deps.clock);
    const hostCounts = new Map<string, number>();
    const capBreaches: string[] = [];
    const signal = wallController.signal;
    let shortCircuit: ShortCircuit | null = null;
    let renderedCount = 0; // actual Tier-3 renders this call (drives the maxRenderedSeeds cap)
    const record = (code: string): void => { if (!capBreaches.includes(code)) capBreaches.push(code); };

    await Promise.all(seeds.map(async (seed, idx) => {
      const acquired = await sem.acquire(signal);
      if (!acquired) { record("bulk_deadline_exceeded"); results[idx] = abortedSeedResult(seed, "bulk_deadline_exceeded", "wall deadline reached"); return; }
      try {
        // CHECK A: wall or HARD short-circuit → abort. SOFT (transform-cost) falls through — beforeSeed
        // fail-softs to raw. (shortCircuit is sibling-mutated; assert the declared type.)
        const scTop = shortCircuit as ShortCircuit | null;
        if (signal.aborted || budget.wallExceeded()) { record("bulk_deadline_exceeded"); results[idx] = abortedSeedResult(seed, "bulk_deadline_exceeded", "wall deadline reached"); return; }
        if (scTop && scTop.hard) { results[idx] = abortedSeedResult(seed, scTop.code, scTop.message); return; }
        const seedKey = seedRegistrableKey(seed);
        if ((hostCounts.get(seedKey) ?? 0) >= guard.maxPerHostInBulk) {
          record("bulk_per_host_cap");
          results[idx] = abortedSeedResult(seed, "bulk_per_host_cap", `per-host cap (${guard.maxPerHostInBulk}) reached for ${seedKey}`);
          return;
        }
        await gate.acquire(seedKey, signal);
        try {
          // Re-check the wall after the rate-gate wait (deadline may fire mid-acort).
          if (signal.aborted || budget.wallExceeded()) {
            record("bulk_deadline_exceeded");
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
          // Serialize transforms (cap 1). Post-slot: wall-abort → deadline; HARD short-circuit (egress/host) → ABORT (don't fetch); transform-cost → fail-soft to raw.
          let transformSlotHeld = false;
          if (effectiveOutput !== "raw") {
            transformSlotHeld = await transformSem.acquire(signal);
            if (!transformSlotHeld) {
              budget.cancelReservation(before.runTransform); // never executed → release the reservation
              record("bulk_deadline_exceeded");
              results[idx] = abortedSeedResult(seed, "bulk_deadline_exceeded", "wall deadline reached");
              return;
            }
            // shortCircuit is mutated by sibling closures (concurrent), so TS's null-narrowing after the
            // top check is unsound here — assert the declared type so the hard-abort path type-checks.
            const sc = shortCircuit as ShortCircuit | null;
            if (sc && sc.hard) {
              budget.cancelReservation(before.runTransform); // never executed → release the reservation
              transformSem.release();
              transformSlotHeld = false;
              results[idx] = abortedSeedResult(seed, sc.code, sc.message);
              return;
            }
            if (shortCircuit || budget.costCapReached()) {
              transformSem.release();
              transformSlotHeld = false;
              effectiveOutput = "raw";
            }
          }
          const downgradedByCost = request.requestedOutput !== "raw" && effectiveOutput === "raw";
          // maxRenderedSeeds (BULK-3): post-settle count over ACTUAL render attempts (attempts with tier 3 —
          // success, empty, OR a 4xx/5xx render, all spawned a browser; codex R12 P2). Overshoot ≤
          // maxConcurrentRenders (the renderer's concurrency cap). reserveRender holds the byte invariant.
          let reservedUnits = 1, renderAllowed = request.allowRender && renderedCount < guard.maxRenderedSeeds;
          if (renderAllowed && !budget.reserveRender()) renderAllowed = false; // byte pool won't fit → refuse render
          if (renderAllowed) reservedUnits += RENDER_EGRESS_MULTIPLIER;
          const renderDowngraded = request.allowRender && !renderAllowed;
          const execInput = { url: seed.url, prompt: request.prompt, output: effectiveOutput, schema: request.schema, budget: request.budget, transform: request.transform, maxBytes: request.maxBytes, timeoutMs: request.timeoutMs, allowRender: renderAllowed, debug: request.debug };
          const execCtx = { ...(context.fetchedAt !== undefined ? { fetchedAt: context.fetchedAt } : {}), signal };
          let seedResult: Result;
          let retried = false, retryReserved = false;
          try {
            // Race EVERY seed against the bulk wall (not just transforms): a raw Tier-1 fetch already
            // aborts on the signal, but a Tier-3 RENDER (allowRender:true) settles in Playwright + the
            // render-concurrency queue, which do NOT observe the signal — without this race a slow JS
            // shell can hold Promise.all past maxGlobalWallMs (codex R2 P2). The wall abandons it
            // (dispatch-level). executeSeedWithRetry performs ONE jittered 429/503 retry (wall-bounded).
            const run = (): Promise<Result> => raceWallAbort(this.deps.executor.execute(execInput, execCtx), signal, seed);
            ({ result: seedResult, retried, retryReserved } = await executeSeedWithRetry(run, { signal, wallExceeded: () => budget.wallExceeded(), reserveRetry: () => budget.reserveRetry(), releaseRetry: () => budget.cancelRetry() }));
          } catch (err) {
            seedResult = syntheticFail(seed, err);
          } finally {
            if (transformSlotHeld) transformSem.release();
          }
          // Count ACTUAL render attempts post-settle: a tier-3 attempt trace = a browser spawned (success, empty,
          // OR a 4xx/5xx render; codex R12 P2). A content page (no tier-3 attempt) doesn't consume the budget.
          if (renderAllowed && seedResult.attempts.some((a) => a.tier === 3)) renderedCount++;
          // The wall may have fired DURING the in-flight execute — disclose it (the result flows
          // straight here, not a record branch). transformReserved mirrors before.runTransform.
          if (signal.aborted) record("bulk_deadline_exceeded");
          const after = budget.afterSeed({ bytes: seedResult.egressBytes ?? seedResult.bytes, costUsd: seedResult.transform?.costUsd, inTokens: seedResult.transform?.inTokens, outTokens: seedResult.transform?.outTokens, transformReserved: before.runTransform, byteUnits: reservedUnits + (retryReserved ? 1 : 0) });
          if (after.shortCircuit) {
            shortCircuit = shortCircuit ?? budgetMsg(after.reason as BudgetCapReason);
            record(`bulk_budget_exceeded:${after.reason}`);
          }
          // Post-settle union count (directed-DoS bound): seed + redirect + finalUrl hosts, PLUS the
          // render's subresource hosts (renderEgressHosts, BULK-3) — quarantine once a REDIRECT/RENDER
          // victim (h !== seedKey) crosses the cap.
          const unionHosts = new Set(unionEgressHosts({ seedRegistrable: registrableDomain(hostOf(seed.url)) ?? hostOf(seed.url), redirects: seedResult.redirects.map((r) => r.url), finalUrl: seedResult.finalUrl }));
          mergeRenderEgressHosts(unionHosts, seedResult.renderEgressHosts);
          for (const h of unionHosts) {
            const next = (hostCounts.get(h) ?? 0) + 1;
            hostCounts.set(h, next);
            if (next > guard.maxPerHostInBulk) record(`bulk_per_host_cap:${h}`);
            if (h !== seedKey && next >= guard.maxPerHostInBulk && (!shortCircuit || !shortCircuit.hard)) {
              shortCircuit = { code: "bulk_per_host_cap", message: `discovered victim ${h} reached the per-bulk cap — remaining seeds aborted`, hard: true };
              record("bulk_per_host_cap");
            }
          }
          // Settled Result.output. Cost-cap/retry warnings describe a degraded-but-successful seed
          // (skip fail rows; pass→partial). The render-cap warning is emitted regardless of status —
          // for a downgraded JS shell it is the cause of the resulting render-blocked fail.
          const row = toBulkSeedResult(seed, seedResult, seedResult.output);
          if ((downgradedByCost || retried) && row.status !== "fail") {
            if (row.status === "pass") row.status = "partial";
            if (downgradedByCost) row.warnings.push({ code: "transform_skipped_cost_cap", message: "Requested summary/extract ran as raw — the per-call transform cost cap was reached." });
            if (retried) row.warnings.push({ code: "bulk_retried_429", message: "Seed returned 429/503 and was retried once after the server's Retry-After." });
          }
          if (renderDowngraded) row.warnings.push({ code: "bulk_render_cap_exceeded", message: "allowRender downgraded to false — the per-call maxRenderedSeeds cap was reached." });
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

function budgetMsg(reason: BudgetCapReason): ShortCircuit {
  return { code: "bulk_budget_exceeded", message: `bulk_budget_exceeded:${reason}`, hard: reason === "egress_bytes" };
}

export function createCaptatumBulkUseCase(deps: CaptatumBulkDeps): CaptatumBulkUseCase {
  return new CaptatumBulkUseCase(deps);
}

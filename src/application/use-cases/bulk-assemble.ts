// BulkResult assembly — extracted from the orchestrator to respect the 250-line limit.
// Pure-ish: takes the run outputs (shaped input, per-seed results, budget, per-entry
// rejects) + a clock for the total-duration stamp, returns the immutable BulkResult
// envelope. Per-entry rejects (invalid URL / board root / ashby embed) count toward
// `failed` + the status so a partial-by-rejects call reports "partial", not "pass".
import { classifyBulkStatus, type BulkGuard, type BulkStatus, type ValidatedSeed } from "../../domain/bulk-policy.ts";
import type { BulkClamp, BulkFailure, BulkResult, BulkSeedResult, BulkTotals } from "../../domain/bulk-result.ts";
import type { ClockPort } from "../ports/clock.ts";
import type { BudgetTracker } from "./bulk-budget.ts";

export function assembleBulkResult(args: {
  bulkId: string;
  fenceToken: string;
  guard: BulkGuard;
  costClamped: string[];
  shaped: ReturnType<typeof import("../../domain/bulk-policy.ts").shapeBulkInput>;
  toProcessCount: number;
  ran: { results: BulkSeedResult[]; capBreaches: string[]; budget: BudgetTracker };
  normalized: {
    invalid: { url: string; code: string; message: string }[];
    schemaKnobWarnings: { code: string; message: string }[];
  };
  boardRejected: ValidatedSeed[];
  ashbyRejected: ValidatedSeed[];
  startMs: number;
  clock: ClockPort;
  /** Per-tenant quota reservation receipt (hosted, BULK-1); undefined on local. */
  quotaReserved?: number;
  quotaWindowSeconds?: number;
  quotaLimit?: number;
}): BulkResult {
  const { bulkId, fenceToken, guard, costClamped, shaped, toProcessCount, ran, normalized, boardRejected, ashbyRejected, startMs, clock } = args;
  const { results, capBreaches, budget } = ran;
  const failedSeeds = results.filter((r) => r.status === "fail");
  const rejectCount = normalized.invalid.length + boardRejected.length + ashbyRejected.length;
  const failures: BulkFailure[] = [
    ...normalized.invalid.map((f) => ({ url: f.url, code: f.code, message: f.message })),
    ...boardRejected.map((s) => ({ url: s.url, code: "tier2_board_not_supported_in_bulk", message: "Tier-2 board-root seeds are rejected per-entry — single-fetch the board roster, then bulk the per-JD URLs." })),
    ...ashbyRejected.map((s) => ({ url: s.url, code: "ashby_embed_not_supported_in_bulk", message: "Ashby-embed (?ashby_jid=) seeds are rejected per-entry — the embed resolver's host-page fetch is not captured by v1 egress accounting. Bulk the direct jobs.ashbyhq.com/<org>/<id> URLs." })),
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
    durationMs: Math.max(0, Math.round(clock.nowMs() - startMs)),
    transformInTokens: budget.transformInTokens,
    transformOutTokens: budget.transformOutTokens,
    transformCostUsd: Math.round(budget.costUsed * 1e6) / 1e6,
  };
  // Status spans BOTH the processed results AND the per-entry rejects (each counts as "fail").
  const statuses: BulkStatus[] = [...results.map((r) => r.status), ...Array.from({ length: rejectCount }, (): BulkStatus => "fail")];
  const status = classifyBulkStatus(statuses);
  return {
    schemaVersion: 1, kind: "bulk", bulkId, ok: status !== "fail", status,
    count: results.length, passed: results.length - failedSeeds.length, failed: failedSeeds.length + rejectCount,
    truncated: perHostDropped, deduped: shaped.deduped, totals, guard, capBreaches, clamp, fenceToken,
    results, failures,
    warnings: [
      ...costClamped.map((c) => ({ code: "bulk_cost_clamped", message: `${c} was clamped to the server ceiling` })),
      ...normalized.schemaKnobWarnings,
    ],
    errors: [],
    ...(args.quotaReserved !== undefined && args.quotaWindowSeconds !== undefined && args.quotaLimit !== undefined
      ? { quota: { reserved: args.quotaReserved, windowSeconds: args.quotaWindowSeconds, limit: args.quotaLimit } }
      : {}),
  };
}

function failureCode(r: BulkSeedResult): string {
  if (r.resolvedVia === "bulk-shortcut") return r.codeText; // a bulk_* short-circuit code
  if (r.tier === "error") return r.errors[0]?.code ?? "fetch_error";
  return `http_${r.code}`;
}

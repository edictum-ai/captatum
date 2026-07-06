// CaptatumExecutorPort — the port the bulk orchestrator depends on (NOT the
// concrete CaptatumUseCase), so admission accounting is unambiguous: the bulk
// CALL acquires exactly ONE admission slot (withAdmission at the MCP route); the
// orchestrator holds the UNWRAPPED executor, so per-seed fan-out takes NO slots.
// Inner fan-out is bounded by the BulkGuard (maxConcurrency + union-keyed per-
// host gate). See docs/contracts.md §"Tool: captatum_bulk" / Admission-path.
import type { CaptatumContext } from "./captatum-context.ts";
import type { Result } from "../../domain/result.ts";

export interface CaptatumExecutorPort {
  /** Execute one single-URL captatum call. Bulk calls this per seed with an
   *  UNWRAPPED executor (no per-seed admission) + the bulk wall-deadline signal
   *  threaded via context. */
  execute(input: unknown, context?: CaptatumContext): Promise<Result>;
  /** The executor's default output (provider-conditional) — used to resolve the
   *  bulk default before the caller's `output` is applied. */
  readonly defaultOutput: "summary" | "raw" | "extract";
}

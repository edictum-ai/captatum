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
  /** The executor's SINGLE-FETCH default output (provider-conditional — `summary`
   *  on hosted, `raw` without a provider). Carried so the admission-wrapped use
   *  case satisfies this port's shape. It does NOT drive the BULK default: bulk
   *  defaults to `raw` (founder decision 2), resolved independently in bulk-input
   *  — never derived from this, or an omitted-output hosted bulk would silently
   *  run N transforms under the 10-URL summary cap. */
  readonly defaultOutput: "summary" | "raw" | "extract";
}

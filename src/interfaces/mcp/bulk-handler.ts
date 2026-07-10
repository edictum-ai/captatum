// The captatum_bulk call handler + its audit emission, extracted from server.ts to respect
// the 250-line limit. The bulk CALL acquires its admission slot at the route boundary (the
// executor passed here is already admission-wrapped on hosted, raw on local); this handler
// does the scope check, runs the orchestrator, emits ONE audit event per seed + ONE summary
// event (tool:"captatum_bulk" + bulkId), and formats the MCP result. A rejecting audit sink
// never converts a successful bulk into a client error. See docs/contracts.md "Audit".
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BulkResult } from "../../domain/bulk-result.ts";
import type { CaptatumContext } from "../../application/ports/captatum-context.ts";
import { OAuthError, requireScope } from "mcp-sso";
import { requiredScopeForCaptatum } from "../../application/scopes.ts";
import { bulkResultToMcpText } from "./bulk-format.ts";
import { buildBulkStructuredContent } from "./bulk-shape.ts";
import { CAPTATUM_BULK_TOOL_NAME } from "./bulk-schema.ts";
import { toMcpError } from "./server.ts";
import type { CaptatumMcpServerDeps, CaptatumBulkMcpExecutor } from "./server.ts";

export type { CaptatumBulkMcpExecutor };

export async function callBulk(args: unknown, deps: CaptatumMcpServerDeps): Promise<CallToolResult> {
  const started = deps.clock.nowMs();
  let bulk: BulkResult;
  try {
    // requireScope is INSIDE the try (mirrors callCaptatum) so an insufficient-scope rejection
    // on the 50× amplification surface is audited + mapped to the auth JSON-RPC code (-32003),
    // not dropped as a generic error. Bulk reuses fetch:read / fetch:transform (no bulk:read in v1);
    // raw default → fetch:read, summary/extract → fetch:transform.
    requireScope(deps.auth, requiredScopeForCaptatum(args, "raw"));
    // Thread clientId so the orchestrator can key the per-tenant BulkQuotaPort reservation (BULK-1).
    bulk = await deps.bulk!.execute(args, { fetchedAt: new Date(deps.clock.nowMs()).toISOString(), clientId: deps.auth.clientId } satisfies CaptatumContext);
  } catch (error) {
    await auditBulkFailure(deps, args, started, error);
    throw toMcpError(error);
  }
  try {
    await auditBulkResult(deps, bulk);
  } catch (auditError) {
    process.stderr.write(`captatum: bulk audit write failed: ${auditError instanceof Error ? auditError.message : auditError}\n`);
  }
  const debug = isRecord(args) && args.debug === true;
  return {
    content: [{ type: "text", text: bulkResultToMcpText(bulk) }],
    structuredContent: buildBulkStructuredContent(bulk, debug),
  };
}

/** Per-seed events (one per seed) + one summary event. The summary carries the run totals +
 *  capBreaches and no per-url body; a sink groups by bulkId and identifies it as the event
 *  with capBreaches set (or no url_host). */
async function auditBulkResult(deps: CaptatumMcpServerDeps, bulk: BulkResult): Promise<void> {
  const occurredAt = new Date(deps.clock.nowMs()).toISOString();
  for (const r of bulk.results) {
    await deps.audit.writeToolEvent({
      occurredAt,
      subject: deps.auth.subject,
      clientId: deps.auth.clientId,
      tool: CAPTATUM_BULK_TOOL_NAME,
      bulkId: bulk.bulkId,
      url_host: urlHost(r.finalUrl),
      tier: r.tier,
      platform: r.platform,
      output: r.output,
      status: r.code,
      bytes: r.bytes,
      durationMs: 0, // per-seed duration is not tracked in v1; the summary event has the total
      transformProvider: r.transform?.provider,
      transformModel: r.transform?.model,
      transformCostUsd: r.transform?.costUsd,
      transformInTokens: r.transform?.inTokens,
      transformOutTokens: r.transform?.outTokens,
    });
  }
  await deps.audit.writeToolEvent({
    occurredAt,
    subject: deps.auth.subject,
    clientId: deps.auth.clientId,
    tool: CAPTATUM_BULK_TOOL_NAME,
    bulkId: bulk.bulkId,
    capBreaches: bulk.capBreaches,
    tier: "none", // marks the summary event (no single tier across N seeds)
    output: "raw",
    status: bulk.ok ? 200 : 0,
    bytes: bulk.totals.bytes,
    durationMs: bulk.totals.durationMs,
    transformCostUsd: bulk.totals.transformCostUsd,
    transformInTokens: bulk.totals.transformInTokens,
    transformOutTokens: bulk.totals.transformOutTokens,
    // BULK-1: the per-tenant reservation, so per-tenant bulk spend is auditable (hosted only).
    ...(bulk.quota ? { quotaReserved: bulk.quota.reserved, quotaWindowSeconds: bulk.quota.windowSeconds } : {}),
  });
}

async function auditBulkFailure(deps: CaptatumMcpServerDeps, args: unknown, started: number, error: unknown): Promise<void> {
  await deps.audit.writeToolEvent({
    occurredAt: new Date(deps.clock.nowMs()).toISOString(),
    subject: deps.auth.subject,
    clientId: deps.auth.clientId,
    tool: CAPTATUM_BULK_TOOL_NAME,
    tier: "error",
    output: inputOutput(args),
    status: error instanceof OAuthError ? error.status : 0,
    bytes: 0,
    durationMs: Math.max(0, Math.round(deps.clock.nowMs() - started)),
  });
}

function urlHost(value: string): string | undefined {
  try { const u = new URL(value); return `${u.protocol}//${u.host}`; } catch { return undefined; }
}

function inputOutput(args: unknown): string | undefined {
  if (!isRecord(args) || typeof args.output !== "string") return undefined;
  return args.output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

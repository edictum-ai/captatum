// Audit ports. captatum's audit sink is a SUPERSET of mcp-sso's: the mcp-sso
// `Bridge` + `RequestAuthorizer` call `writeAuthEvent` (mcp-sso's `AuthAuditEvent`),
// while captatum's tool handlers call `writeToolEvent` (captatum's `ToolAuditEvent`).
// Re-exporting mcp-sso's auth-event types here means a single captatum audit object
// satisfies BOTH mcp-sso's `AuditPort` and captatum's `AuditLoggerPort` — one unified
// audit log, no duplicated seam (per the S0b plan). mcp-sso's `AuthAuditEvent` is a
// superset of captatum's prior in-house type (same fields + `ip?`), so existing
// captatum event construction stays valid.
export type { AuthAuditEvent, AuthAuditStatus, AuthAuditEventName } from "mcp-sso";
import type { AuthAuditEvent } from "mcp-sso";

export interface ToolAuditEvent {
  occurredAt: string;
  subject?: string;
  clientId?: string;
  tool: "captatum" | "captatum_bulk";
  /** Per-bulk-call correlation id when `tool === "captatum_bulk"`. Present on every
   *  per-seed event in a bulk + the one summary event, so a sink can group them. */
  bulkId?: string;
  /** Which BulkGuard caps short-circuited the run. Present only on the captatum_bulk
   *  SUMMARY event (one per call); per-seed events omit it. Empty/absent = no breach. */
  capBreaches?: string[];
  url_host?: string;
  tier?: string | number;
  platform?: string;
  output?: string;
  status: number;
  bytes: number;
  durationMs: number;
  transformProvider?: string;
  transformModel?: string;
  /** Per-call transform cost in USD (from the provider's usage.cost). Surface in your observability sink for spend tracking. */
  transformCostUsd?: number;
  transformInTokens?: number;
  transformOutTokens?: number;
  /** Failed-primary model list when the router fell back to a later candidate (#82). Operator-only
   *  (the user-facing receipt is silent on a successful fallback); surface in your observability sink. */
  transformFallbackFrom?: string;
  /** Seeds reserved against the calling tenant's per-call quota window (BULK-1). Present only on
   *  the captatum_bulk SUMMARY event when a BulkQuotaPort is configured (hosted); absent on local. */
  quotaReserved?: number;
  /** The quota window length in seconds (BULK-1). Present only on the captatum_bulk SUMMARY event
   *  when a BulkQuotaPort is configured (hosted). */
  quotaWindowSeconds?: number;
}

/** captatum's audit port: mcp-sso's auth-event sink (`writeAuthEvent`) + captatum's
 *  tool-event sink (`writeToolEvent`). An object implementing both satisfies mcp-sso's
 *  narrower `AuditPort` structurally — pass the same instance to the `Bridge` /
 *  `RequestAuthorizer` and to captatum's tool handlers. */
export interface AuditLoggerPort {
  writeAuthEvent(event: AuthAuditEvent): Promise<void>;
  writeToolEvent(event: ToolAuditEvent): Promise<void>;
}

export const noopAuditLogger: AuditLoggerPort = {
  async writeAuthEvent(): Promise<void> {
    // Intentionally empty for tests/local composition.
  },
  async writeToolEvent(): Promise<void> {
    // Intentionally empty for tests/local composition.
  },
};

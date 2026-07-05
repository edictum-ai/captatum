export type AuthAuditStatus = "success" | "failure";

export type AuthAuditEventName =
  | "oauth.register"
  | "oauth.authorize.prepare"
  | "oauth.authorize.approve"
  | "oauth.token.authorization_code"
  | "oauth.token.refresh"
  | "oauth.revoke"
  | "auth.request";

export interface AuthAuditEvent {
  occurredAt: string;
  event: AuthAuditEventName;
  status: AuthAuditStatus;
  clientId?: string;
  subject?: string;
  resource?: string;
  scopes?: string[];
  redirectHost?: string;
  reason?: string;
}

export interface ToolAuditEvent {
  occurredAt: string;
  subject?: string;
  clientId?: string;
  tool: "captatum";
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
}

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

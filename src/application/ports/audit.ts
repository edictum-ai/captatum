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

export interface AuditLoggerPort {
  writeAuthEvent(event: AuthAuditEvent): Promise<void>;
}

export const noopAuditLogger: AuditLoggerPort = {
  async writeAuthEvent(): Promise<void> {
    // Intentionally empty for tests/local composition.
  },
};

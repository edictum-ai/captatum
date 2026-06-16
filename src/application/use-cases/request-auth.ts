import type { ClockPort } from "../ports/clock.ts";
import type { AuditLoggerPort } from "../ports/audit.ts";
import type { AuthRuntimeConfig, HostedOAuthConfig } from "./oauth-config.ts";
import type { AuthorizedSubject, OAuthScope } from "./oauth-scopes.ts";
import { requireScope } from "./oauth-scopes.ts";
import { OAuthError } from "./oauth-errors.ts";
import { verifyAccessToken } from "./oauth-crypto.ts";

export interface RequestAuthDeps {
  runtime: AuthRuntimeConfig;
  clock: ClockPort;
  audit: AuditLoggerPort;
}

export interface RequestAuthInput {
  authorization?: string | string[];
  requiredScope?: OAuthScope;
}

export type RequestAuthResult = AuthorizedSubject & { localBypass?: boolean };

const LOCAL_AUTH: RequestAuthResult = {
  subject: "local-user",
  clientId: "local-binary",
  scopes: ["fetch:read", "fetch:transform"],
  localBypass: true,
};

export class RequestAuthorizer {
  private readonly runtime: AuthRuntimeConfig;
  private readonly clock: ClockPort;
  private readonly audit: AuditLoggerPort;

  constructor(deps: RequestAuthDeps) {
    this.runtime = deps.runtime;
    this.clock = deps.clock;
    this.audit = deps.audit;
  }

  async authorize(input: RequestAuthInput): Promise<RequestAuthResult> {
    if (this.runtime.flavor === "local-binary") {
      await this.auditResult("success", LOCAL_AUTH, input.requiredScope);
      return LOCAL_AUTH;
    }
    return await this.authorizeHosted(this.runtime.oauth, input);
  }

  private async authorizeHosted(
    config: HostedOAuthConfig,
    input: RequestAuthInput,
  ): Promise<RequestAuthResult> {
    try {
      const token = bearerToken(input.authorization);
      const verified = await verifyAccessToken(token, config, this.clock);
      if (input.requiredScope) requireScope(verified, input.requiredScope);
      await this.auditResult("success", verified, input.requiredScope);
      return verified;
    } catch (error) {
      await this.audit.writeAuthEvent({
        occurredAt: new Date(this.clock.nowMs()).toISOString(),
        event: "auth.request",
        status: "failure",
        reason: error instanceof OAuthError ? error.code : "invalid_token",
      });
      throw error;
    }
  }

  private async auditResult(
    status: "success",
    auth: RequestAuthResult,
    requiredScope?: OAuthScope,
  ): Promise<void> {
    await this.audit.writeAuthEvent({
      occurredAt: new Date(this.clock.nowMs()).toISOString(),
      event: "auth.request",
      status,
      clientId: auth.clientId,
      subject: auth.subject,
      scopes: auth.scopes,
      reason: requiredScope,
    });
  }
}

export function createRequestAuthorizer(deps: RequestAuthDeps): RequestAuthorizer {
  return new RequestAuthorizer(deps);
}

function bearerToken(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new OAuthError("invalid_token", "Bearer token is required", 401);
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (!match?.[1]) throw new OAuthError("invalid_token", "Bearer token is required", 401);
  return match[1];
}

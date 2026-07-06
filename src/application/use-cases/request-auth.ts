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

// Actionable for a non-OAuth Streamable HTTP client that POSTs to /mcp without the
// OAuth flow: it must learn HOW to get a token, not just that one is missing. The
// same text reaches the client via the JSON-RPC `message` and the RFC 6750
// `WWW-Authenticate: Bearer … error_description`. (#104)
const TOKEN_REQUIRED_MESSAGE =
  "OAuth Bearer access token required — obtain one via /oauth/token, then resend 'Authorization: Bearer <token>'";

function bearerToken(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new OAuthError("invalid_token", TOKEN_REQUIRED_MESSAGE, 401);
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (!match?.[1]) throw new OAuthError("invalid_token", TOKEN_REQUIRED_MESSAGE, 401);
  return match[1];
}

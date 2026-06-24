import type { ClockPort } from "../ports/clock.ts";
import type { AuditLoggerPort } from "../ports/audit.ts";
import type { StorePort, AuthCodeRecord, RefreshTokenRecord } from "../ports/store.ts";
import type { HostedOAuthConfig } from "./oauth-config.ts";
import { OAuthError } from "./oauth-errors.ts";
import {
  expiresAtIso,
  generateRefreshToken,
  parseRefreshFamilyId,
  sha256Hex,
  signAccessToken,
  verifyPkceS256,
} from "./oauth-crypto.ts";
import { normalizeScopes, scopeString } from "./oauth-scopes.ts";

export interface OAuthTokenDeps {
  config: HostedOAuthConfig;
  store: StorePort;
  clock: ClockPort;
  audit: AuditLoggerPort;
}

export interface AuthorizationCodeGrantInput {
  grantType?: string;
  code?: string;
  redirectUri?: string;
  clientId?: string;
  codeVerifier?: string;
}

export interface RefreshGrantInput {
  grantType?: string;
  refreshToken?: string;
  clientId?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export class OAuthTokenUseCase {
  private readonly config: HostedOAuthConfig;
  private readonly store: StorePort;
  private readonly clock: ClockPort;
  private readonly audit: AuditLoggerPort;

  constructor(deps: OAuthTokenDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.clock = deps.clock;
    this.audit = deps.audit;
  }

  async exchangeAuthorizationCode(input: AuthorizationCodeGrantInput): Promise<TokenResponse> {
    try {
      if (input.grantType !== "authorization_code") {
        throw new OAuthError("unsupported_grant_type", "grant_type is not supported");
      }
      const record = await this.consumeValidCode(input);
      const refreshToken = generateRefreshToken();
      const familyId = parseRefreshFamilyId(refreshToken);
      if (!familyId) throw new OAuthError("server_error", "Refresh token generation failed", 500);
      await this.store.saveRefreshToken({
        tokenHash: sha256Hex(refreshToken),
        familyId,
        previousTokenHash: null,
        clientId: record.clientId,
        subject: record.subject,
        scopes: record.scopes,
        expiresAt: expiresAtIso(this.clock, this.config.refreshTokenTtlSeconds),
      });
      await this.auditToken("oauth.token.authorization_code", "success", record);
      return await this.tokenResponse(record, refreshToken);
    } catch (error) {
      await this.auditFailure("oauth.token.authorization_code", error, input.clientId);
      throw error;
    }
  }

  async refresh(input: RefreshGrantInput): Promise<TokenResponse> {
    try {
      if (input.grantType !== "refresh_token") {
        throw new OAuthError("unsupported_grant_type", "grant_type is not supported");
      }
      const raw = required(input.refreshToken, "refresh_token");
      const familyId = parseRefreshFamilyId(raw);
      if (!familyId) throw new OAuthError("invalid_grant", "Refresh token is invalid");
      const nextRaw = generateRefreshToken(familyId);
      const previousHash = sha256Hex(raw);
      const rotated = await this.store.rotateRefreshToken(
        previousHash,
        {
          tokenHash: sha256Hex(nextRaw),
          familyId,
          previousTokenHash: previousHash,
          clientId: input.clientId ?? "",
          subject: "",
          scopes: [],
          expiresAt: expiresAtIso(this.clock, this.config.refreshTokenTtlSeconds),
        },
        new Date(this.clock.nowMs()).toISOString(),
      );
      if (!rotated) throw new OAuthError("invalid_grant", "Refresh token is invalid");
      // RFC 6749 §6: the refresh grant must be bound to the token's client. The
      // rotated record carries the STORED client_id; a missing/mismatched
      // client_id signals theft/replay — revoke the family and reject.
      if (!input.clientId || input.clientId !== rotated.clientId) {
        await this.store.revokeRefreshTokenFamily(familyId, new Date(this.clock.nowMs()).toISOString());
        throw new OAuthError("invalid_grant", "Refresh token client binding is invalid");
      }
      await this.auditToken("oauth.token.refresh", "success", rotated);
      return await this.tokenResponse(rotated, nextRaw);
    } catch (error) {
      await this.auditFailure("oauth.token.refresh", error, input.clientId);
      throw error;
    }
  }

  async revoke(refreshToken: string | undefined): Promise<void> {
    const nowIso = new Date(this.clock.nowMs()).toISOString();
    let familyId: string | undefined;
    if (refreshToken) {
      // Verify the token hash exists before revoking — a token with a valid
      // format but non-existent hash (or a guessed family id) must not revoke a
      // real family (PR-9 deferred hash check).
      const existing = await this.store.findRefreshToken(sha256Hex(refreshToken));
      if (existing) {
        familyId = existing.familyId;
        await this.store.revokeRefreshTokenFamily(familyId, nowIso);
      }
    }
    await this.audit.writeAuthEvent({
      occurredAt: nowIso,
      event: "oauth.revoke",
      status: "success",
      reason: familyId ? undefined : "unrecognized_token",
    });
  }

  private async consumeValidCode(input: AuthorizationCodeGrantInput): Promise<AuthCodeRecord> {
    const code = required(input.code, "code");
    const record = await this.store.consumeAuthCode(
      sha256Hex(code),
      new Date(this.clock.nowMs()).toISOString(),
    );
    if (!record) throw new OAuthError("invalid_grant", "Authorization code is invalid");
    if (input.clientId !== record.clientId || input.redirectUri !== record.redirectUri) {
      throw new OAuthError("invalid_grant", "Authorization code binding is invalid");
    }
    if (!verifyPkceS256(required(input.codeVerifier, "code_verifier"), record.codeChallenge)) {
      throw new OAuthError("invalid_grant", "PKCE verifier is invalid");
    }
    return record;
  }

  private async tokenResponse(record: AuthCodeRecord | RefreshTokenRecord, refreshToken: string): Promise<TokenResponse> {
    const scopes = normalizeScopes(record.scopes);
    const accessToken = await signAccessToken({
      subject: record.subject,
      clientId: record.clientId,
      scopes,
    }, this.config, this.clock);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopeString(scopes),
    };
  }

  private async auditToken(
    event: "oauth.token.authorization_code" | "oauth.token.refresh",
    status: "success",
    record: AuthCodeRecord | RefreshTokenRecord,
  ): Promise<void> {
    await this.audit.writeAuthEvent({
      occurredAt: new Date(this.clock.nowMs()).toISOString(),
      event,
      status,
      clientId: record.clientId,
      subject: record.subject,
      resource: this.config.resource,
      scopes: record.scopes,
    });
  }

  private async auditFailure(
    event: "oauth.token.authorization_code" | "oauth.token.refresh",
    error: unknown,
    clientId?: string,
  ): Promise<void> {
    await this.audit.writeAuthEvent({
      occurredAt: new Date(this.clock.nowMs()).toISOString(),
      event,
      status: "failure",
      clientId,
      reason: error instanceof OAuthError ? error.code : "internal_error",
    });
  }
}

function required(value: string | undefined, label: string): string {
  if (typeof value === "string" && value) return value;
  throw new OAuthError("invalid_request", `${label} is required`);
}

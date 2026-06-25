import type { ClockPort } from "../ports/clock.ts";
import type { AuditLoggerPort } from "../ports/audit.ts";
import type { StorePort } from "../ports/store.ts";
import type { HostedOAuthConfig } from "./oauth-config.ts";
import type { OAuthScope } from "./oauth-scopes.ts";
import { normalizeScopes } from "./oauth-scopes.ts";
import { OAuthError } from "./oauth-errors.ts";
import {
  expiresAtIso,
  generateAuthorizationCode,
  sha256Hex,
  signConsentToken,
  verifyConsentToken,
  type ConsentRequestClaims,
} from "./oauth-crypto.ts";

export interface OAuthAuthorizationDeps {
  config: HostedOAuthConfig;
  store: StorePort;
  clock: ClockPort;
  audit: AuditLoggerPort;
}

export interface AuthorizeRequestInput {
  clientId?: string;
  redirectUri?: string;
  responseType?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  resource?: string;
  scope?: string;
  state?: string;
  /** Authenticated subject — the verified Cloudflare Access email. REQUIRED (AUTH-1: no placeholder fallback). */
  subject?: string;
}

export interface PreparedConsent extends ConsentRequestClaims {
  consentToken: string;
}

export interface ApproveInput {
  consentToken: string;
  approved?: boolean;
}

export interface ApprovedAuthorizationCode {
  redirectTo: string;
  code: string;
  state?: string;
}

export class OAuthAuthorizationUseCase {
  private readonly config: HostedOAuthConfig;
  private readonly store: StorePort;
  private readonly clock: ClockPort;
  private readonly audit: AuditLoggerPort;

  constructor(deps: OAuthAuthorizationDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.clock = deps.clock;
    this.audit = deps.audit;
  }

  async prepare(input: AuthorizeRequestInput): Promise<PreparedConsent> {
    try {
      const request = this.validateAuthorize(input);
      const consentToken = await signConsentToken(request, this.config, this.clock);
      await this.auditAuth("oauth.authorize.prepare", "success", request);
      return { consentToken, ...request };
    } catch (error) {
      await this.auditFailure("oauth.authorize.prepare", error, input.clientId, input.redirectUri);
      throw error;
    }
  }

  async approve(input: ApproveInput): Promise<ApprovedAuthorizationCode> {
    try {
      if (input.approved === false) throw new OAuthError("access_denied", "Consent was denied");
      const consent = await verifyConsentToken(required(input.consentToken, "consent_token"), this.config, this.clock);
      const code = generateAuthorizationCode();
      await this.store.saveAuthCode({
        codeHash: sha256Hex(code),
        clientId: consent.clientId,
        subject: consent.subject,
        redirectUri: consent.redirectUri,
        resource: consent.resource,
        scopes: consent.scopes,
        codeChallenge: consent.codeChallenge,
        codeChallengeMethod: "S256",
        expiresAt: expiresAtIso(this.clock, this.config.authorizationCodeTtlSeconds),
      });
      await this.auditAuth("oauth.authorize.approve", "success", consent, consent.subject);
      return { code, redirectTo: this.redirectWithCode(consent.redirectUri, code, consent.state), state: consent.state };
    } catch (error) {
      await this.auditFailure("oauth.authorize.approve", error);
      throw error;
    }
  }

  private validateAuthorize(input: AuthorizeRequestInput): ConsentRequestClaims {
    if (input.responseType !== "code") {
      throw new OAuthError("unsupported_response_type", "Only response_type=code is supported");
    }
    const clientId = required(input.clientId, "client_id");
    const redirectUri = this.allowedRedirect(required(input.redirectUri, "redirect_uri"));
    const resource = input.resource || this.config.resource;
    if (resource !== this.config.resource) throw new OAuthError("invalid_target", "Unknown OAuth resource");
    if (input.codeChallengeMethod !== "S256") {
      throw new OAuthError("invalid_request", "PKCE code_challenge_method must be S256");
    }
    const codeChallenge = required(input.codeChallenge, "code_challenge");
    const scopes = normalizeScopes(input.scope);
    return { clientId, redirectUri, resource, scopes, codeChallenge, codeChallengeMethod: "S256", state: input.state, subject: required(input.subject, "subject") };
  }

  private allowedRedirect(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new OAuthError("invalid_redirect_uri", "redirect_uri is invalid");
    }
    if (url.username || url.password) {
      throw new OAuthError("invalid_redirect_uri", "redirect_uri must not contain userinfo");
    }
    url.hash = "";
    const normalized = url.href;
    const origin = `${url.protocol}//${url.host}`;
    // OAUTH-1/CONFIG-3: no allow-all ("*") and no unanchored prefix match — both
    // enabled open-redirect -> auth-code exfiltration. An entry matches only if it
    // is the exact redirect_uri, or an exact ORIGIN (scheme://host[:port], no path).
    const ok = this.config.redirectAllowlist.some((entry) => {
      if (entry === "*") return false;
      if (entry === normalized) return true;
      try {
        const e = new URL(entry);
        return (!e.pathname || e.pathname === "/") && !e.search && `${e.protocol}//${e.host}` === origin;
      } catch {
        return false;
      }
    });
    if (!ok) throw new OAuthError("invalid_redirect_uri", "redirect_uri is not allowed");
    return normalized;
  }

  private redirectWithCode(redirectUri: string, code: string, state?: string): string {
    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    url.searchParams.set("iss", this.config.issuer);
    if (state) url.searchParams.set("state", state);
    return url.href;
  }

  private async auditAuth(
    event: "oauth.authorize.prepare" | "oauth.authorize.approve",
    status: "success",
    request: Pick<PreparedConsent, "clientId" | "redirectUri" | "resource" | "scopes">,
    subject?: string,
  ): Promise<void> {
    await this.audit.writeAuthEvent({
      occurredAt: new Date(this.clock.nowMs()).toISOString(),
      event,
      status,
      clientId: request.clientId,
      subject,
      resource: request.resource,
      scopes: request.scopes,
      redirectHost: hostOf(request.redirectUri),
    });
  }

  private async auditFailure(
    event: "oauth.authorize.prepare" | "oauth.authorize.approve",
    error: unknown,
    clientId?: string,
    redirectUri?: string,
  ): Promise<void> {
    await this.audit.writeAuthEvent({
      occurredAt: new Date(this.clock.nowMs()).toISOString(),
      event,
      status: "failure",
      clientId,
      redirectHost: redirectUri ? hostOf(redirectUri) : undefined,
      reason: error instanceof OAuthError ? error.code : "internal_error",
    });
  }
}

function required(value: string | undefined, label: string): string {
  if (typeof value === "string" && value) return value;
  throw new OAuthError("invalid_request", `${label} is required`);
}

function hostOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

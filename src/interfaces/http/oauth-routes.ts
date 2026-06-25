import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ClockPort } from "../../application/ports/clock.ts";
import type { AuditLoggerPort } from "../../application/ports/audit.ts";
import type { StorePort } from "../../application/ports/store.ts";
import type { HostedOAuthConfig } from "../../application/use-cases/oauth-config.ts";
import { publicJwk } from "../../application/use-cases/oauth-crypto.ts";
import { OAuthAuthorizationUseCase, assertAllowedRedirectUri, type AuthorizeRequestInput } from "../../application/use-cases/oauth-authorization.ts";
import { OAuthTokenUseCase } from "../../application/use-cases/oauth-token.ts";
import { OAuthError, oauthErrorBody } from "../../application/use-cases/oauth-errors.ts";
import { OAUTH_SCOPES } from "../../application/use-cases/oauth-scopes.ts";

/** Cloudflare Access JWT verifier port. The concrete verifier is built once in the
 * composition root and injected via deps (testable; not a module-import side effect). */
export type CfAccessVerifier = (token: string) => Promise<
  | { ok: true; claims: { email: string } }
  | { ok: false; reason: string }
>;

export interface OAuthRoutesDeps {
  config: HostedOAuthConfig;
  store: StorePort;
  clock: ClockPort;
  audit: AuditLoggerPort;
  allowedOrigins: string[];
  /** Required for the hosted flavor: verifies Cf-Access-Jwt-Assertion so the OAuth
   * subject is a real verified identity. Absent => /oauth/authorize fails closed (AUTH-1). */
  cfAccessVerifier?: CfAccessVerifier;
}

const CONSENT_COOKIE = "captatum_consent";

async function resolveSubject(verifier: CfAccessVerifier | undefined, headers: FastifyRequest["headers"]): Promise<string> {
  // AUTH-1: NEVER fall back to a placeholder subject. No verifier => fail closed.
  if (!verifier) throw new OAuthError("access_denied", "Cloudflare Access identity is required but not configured", 401);
  const token = headerString(headers, "cf-access-jwt-assertion");
  if (!token) throw new OAuthError("access_denied", "Cloudflare Access JWT is required", 401);
  const verified = await verifier(token);
  if (!verified.ok) throw new OAuthError("access_denied", `Cloudflare Access JWT rejected: ${verified.reason}`, 401);
  return verified.claims.email;
}
function headerString(headers: FastifyRequest["headers"], name: string): string | undefined { const v = headers[name]; return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined; }
export async function registerOAuthRoutes(app: FastifyInstance, deps: OAuthRoutesDeps): Promise<void> {
  addFormParser(app);
  const authorization = new OAuthAuthorizationUseCase(deps);
  const token = new OAuthTokenUseCase(deps);

  app.get("/.well-known/oauth-authorization-server", async () => authorizationServerMetadata(deps.config));
  app.get("/.well-known/oauth-protected-resource", async () => protectedResourceMetadata(deps.config));
  app.get("/oauth/jwks", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=60");
    return { keys: [publicJwk(deps.config)] };
  });

  app.post("/oauth/register", async (request, reply) => registerClient(request, reply, deps));
  app.get("/oauth/authorize", async (request, reply) => {
    try {
      const prepared = await authorization.prepare({ ...queryParams(request), subject: await resolveSubject(deps.cfAccessVerifier, request.headers) });
      setConsentCookie(reply, prepared.consentToken, deps.config.consentTokenTtlSeconds);
      const esc = (v: string) => v.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!);
      const scopeList = prepared.scopes.map((s) => `<div class="scope">${esc(s)}</div>`).join("");
      reply.type("text/html").header("x-content-type-options", "nosniff").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'").send(
        `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>captatum Authorize</title><style>body{font-family:system-ui,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;color:#1a1a1a}h1{font-size:1.3rem}.scope{background:#f4f4f4;padding:8px 12px;border-radius:6px;font-family:monospace;font-size:.85rem;margin:4px 0}form{margin-top:24px}button{padding:10px 24px;font-size:1rem;border:none;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer}</style></head><body><h1>Authorize captatum</h1><p>An application requests access to <strong>${esc(prepared.resource)}</strong>.</p><p>Requested scopes:</p>${scopeList}<form method="POST" action="/oauth/authorize/approve"><input type="hidden" name="consent_token" value="${prepared.consentToken}"><input type="hidden" name="approved" value="true"><button type="submit">Approve</button></form></body></html>`,
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/oauth/authorize/approve", async (request, reply) => {
    try {
      // OAUTH-4: CSRF defense — fail CLOSED. A state-changing approve POST MUST
      // carry a same-origin (issuer) or explicitly-allowed Origin; a missing or
      // foreign Origin is rejected, never ignored.
      const origin = headerString(request.headers, "origin");
      const issuerOrigin = deps.config.issuer.replace(/\/$/, "");
      if (!origin || (!deps.allowedOrigins.includes(origin) && origin !== issuerOrigin)) {
        return sendError(reply, new OAuthError("invalid_origin", "Origin not allowed", 403));
      }
      const body = objectBody(request.body);
      const approved = body.approved === undefined ? true : body.approved === true || body.approved === "true";
      const result = await authorization.approve({ approved, consentToken: stringField(body.consent_token) ?? consentCookie(request) ?? "" });
      reply.code(302).header("location", result.redirectTo).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/oauth/token", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      const body = objectBody(request.body);
      const grantType = stringField(body.grant_type);
      const response = grantType === "refresh_token"
        ? await token.refresh({
          grantType,
          refreshToken: stringField(body.refresh_token),
          clientId: stringField(body.client_id),
        })
        : await token.exchangeAuthorizationCode({
          grantType,
          code: stringField(body.code),
          redirectUri: stringField(body.redirect_uri),
          clientId: stringField(body.client_id),
          codeVerifier: stringField(body.code_verifier),
        });
      return response;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/oauth/revoke", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const body = objectBody(request.body);
    await token.revoke(stringField(body.token));
    return reply.code(200).send({});
  });
}

function authorizationServerMetadata(config: HostedOAuthConfig): Record<string, unknown> {
  return {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/oauth/authorize`,
    token_endpoint: `${config.issuer}/oauth/token`,
    jwks_uri: `${config.issuer}/oauth/jwks`,
    registration_endpoint: `${config.issuer}/oauth/register`,
    revocation_endpoint: `${config.issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: OAUTH_SCOPES,
  };
}

function protectedResourceMetadata(config: HostedOAuthConfig): Record<string, unknown> {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: OAUTH_SCOPES,
  };
}

async function registerClient(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: OAuthRoutesDeps,
): Promise<Record<string, unknown> | void> {
  try {
    const body = objectBody(request.body);
    const redirectUris = arrayOfStrings(body.redirect_uris);
    for (const uri of redirectUris) assertAllowedRedirect(uri, deps.config.redirectAllowlist);
    await deps.audit.writeAuthEvent({
      occurredAt: new Date(deps.clock.nowMs()).toISOString(),
      event: "oauth.register",
      status: "success",
      redirectHost: redirectUris[0] ? hostOf(redirectUris[0]) : undefined,
    });
    return {
      client_id: `ctc_${cryptoRandom()}`,
      client_id_issued_at: Math.floor(deps.clock.nowMs() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
    };
  } catch (error) {
    await deps.audit.writeAuthEvent({
      occurredAt: new Date(deps.clock.nowMs()).toISOString(),
      event: "oauth.register",
      status: "failure",
      reason: error instanceof OAuthError ? error.code : "invalid_request",
    });
    return sendError(reply, error);
  }
}

function addFormParser(app: FastifyInstance): void {
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    const params = new URLSearchParams(String(body));
    done(null, Object.fromEntries(params.entries()));
  });
}

function queryParams(request: FastifyRequest): AuthorizeRequestInput {
  const query = objectBody(request.query);
  return {
    clientId: stringField(query.client_id),
    redirectUri: stringField(query.redirect_uri),
    responseType: stringField(query.response_type),
    codeChallenge: stringField(query.code_challenge),
    codeChallengeMethod: stringField(query.code_challenge_method),
    resource: stringField(query.resource),
    scope: stringField(query.scope),
    state: stringField(query.state),
  };
}

function sendError(reply: FastifyReply, error: unknown): void {
  const oauthError = error instanceof OAuthError
    ? error
    : new OAuthError("internal_error", "OAuth request failed", 500);
  if (oauthError.status === 401) reply.header("www-authenticate", "Bearer");
  reply.code(oauthError.status).send(oauthErrorBody(oauthError));
}

function objectBody(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function consentCookie(request: FastifyRequest): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  const cookies = raw.split(";").map((part) => part.trim());
  const prefix = `${CONSENT_COOKIE}=`;
  const found = cookies.find((part) => part.startsWith(prefix));
  return found ? decodeURIComponent(found.slice(prefix.length)) : undefined;
}

function setConsentCookie(reply: FastifyReply, token: string, ttlSeconds: number): void {
  reply.header(
    "set-cookie",
    `${CONSENT_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/oauth/authorize; Max-Age=${ttlSeconds}`,
  );
}

function assertAllowedRedirect(value: string, allowlist: string[]): void {
  // OAUTH-1/CONFIG-3: shared validator (no allow-all, no unanchored prefix) — same
  // rule as /oauth/authorize, so register + authorize cannot drift. Register is
  // stateless, so this is defense-in-depth, but kept consistent by construction.
  assertAllowedRedirectUri(value, allowlist);
}

function hostOf(value: string): string | undefined {
  try { const url = new URL(value); return `${url.protocol}//${url.host}`; } catch { return undefined; }
}

function cryptoRandom(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

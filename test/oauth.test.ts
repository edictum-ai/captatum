import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import type { JWK } from "jose";
import type { AuditLoggerPort, AuthAuditEvent } from "../src/application/ports/audit.ts";
import type { ClockPort } from "../src/application/ports/clock.ts";
import type {
  AuthCodeRecord,
  RefreshTokenRecord,
  SaveAuthCodeInput,
  SaveRefreshTokenInput,
  StorePort,
} from "../src/application/ports/store.ts";
import { loadAuthRuntimeConfig } from "../src/application/use-cases/oauth-config.ts";
import type { HostedOAuthConfig } from "../src/application/use-cases/oauth-config.ts";
import { pkceChallenge, sha256Hex, verifyAccessToken } from "../src/application/use-cases/oauth-crypto.ts";
import { requireScope, requiredScopeForSmartFetch } from "../src/application/use-cases/oauth-scopes.ts";
import { createRequestAuthorizer } from "../src/application/use-cases/request-auth.ts";
import { registerOAuthRoutes } from "../src/interfaces/http/oauth-routes.ts";

const NOW_MS = Date.parse("2026-06-16T12:00:00.000Z");
const REDIRECT = "https://client.test/callback";

test("PKCE S256 authorize/approve/token flow issues ES256 access token and hashed refresh", async () => {
  const ctx = await setup();
  const verifier = "correct-horse-battery-staple-0123456789abcdef0123";
  const approved = await approveCode(ctx, verifier, "fetch:read fetch:transform");

  const token = await postForm(ctx, "/oauth/token", {
    grant_type: "authorization_code",
    code: approved.code,
    redirect_uri: REDIRECT,
    client_id: "client-1",
    code_verifier: verifier,
  });

  assert.equal(token.statusCode, 200);
  assert.match(String(token.headers["cache-control"]), /no-store/);
  const body = token.json() as TokenJson;
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.expires_in, 600);
  assert.equal(body.scope, "fetch:read fetch:transform");
  assert.match(body.access_token, /^[^.]+\.[^.]+\.[^.]+$/);
  assert.match(body.refresh_token, /^sfrt\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const verified = await verifyAccessToken(body.access_token, ctx.config, ctx.clock);
  assert.equal(verified.subject, "hosted-user");
  assert.equal(verified.clientId, "client-1");
  assert.deepEqual(verified.scopes, ["fetch:read", "fetch:transform"]);
  assertNoRawSecrets(ctx.store.snapshot(), [approved.code, body.refresh_token]);
  assertNoRawSecrets(JSON.stringify(ctx.audit.events), [approved.code, body.refresh_token, body.access_token]);
  assert.deepEqual(ctx.audit.events.map((event) => [event.event, event.status]), [
    ["oauth.authorize.prepare", "success"],
    ["oauth.authorize.approve", "success"],
    ["oauth.token.authorization_code", "success"],
  ]);
  await ctx.app.close();
});

test("authorize rejects redirects outside the allowlist without a redirect", async () => {
  const ctx = await setup();
  const response = await ctx.app.inject({
    method: "GET",
    url: "/oauth/authorize",
    query: {
      response_type: "code",
      client_id: "client-1",
      redirect_uri: "https://evil.test/callback",
      code_challenge: pkceChallenge("verifier-12345678901234567890"),
      code_challenge_method: "S256",
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.headers.location, undefined);
  assert.deepEqual(response.json(), {
    error: { code: "invalid_redirect_uri", message: "redirect_uri is not allowed" },
  });
  assert.equal(ctx.audit.events.at(-1)?.reason, "invalid_redirect_uri");
  await ctx.app.close();
});

test("invalid verifier consumes auth code and prevents later reuse", async () => {
  const ctx = await setup();
  const verifier = "valid-verifier-123456789012345678901234567890123";
  const approved = await approveCode(ctx, verifier, "fetch:read");

  const bad = await postForm(ctx, "/oauth/token", {
    grant_type: "authorization_code",
    code: approved.code,
    redirect_uri: REDIRECT,
    client_id: "client-1",
    code_verifier: "wrong-verifier-123456789012345678901234567890123",
  });
  assert.equal(bad.statusCode, 400);
  assert.equal((bad.json() as ErrorJson).error.code, "invalid_grant");

  const retry = await postForm(ctx, "/oauth/token", {
    grant_type: "authorization_code",
    code: approved.code,
    redirect_uri: REDIRECT,
    client_id: "client-1",
    code_verifier: verifier,
  });
  assert.equal(retry.statusCode, 400);
  assert.equal((retry.json() as ErrorJson).error.code, "invalid_grant");
  await ctx.app.close();
});

test("expired auth code returns structured auth error and no token", async () => {
  const ctx = await setup();
  const verifier = "valid-verifier-abcdef123456789012345678901234567890123";
  const approved = await approveCode(ctx, verifier, "fetch:read");
  ctx.clock.advance(301_000);

  const response = await postForm(ctx, "/oauth/token", {
    grant_type: "authorization_code",
    code: approved.code,
    redirect_uri: REDIRECT,
    client_id: "client-1",
    code_verifier: verifier,
  });

  assert.equal(response.statusCode, 400);
  assert.equal((response.json() as ErrorJson).error.code, "invalid_grant");
  assert.equal("access_token" in (response.json() as Record<string, unknown>), false);
  await ctx.app.close();
});

test("refresh token rotates and replay revokes the family", async () => {
  const ctx = await setup();
  const initial = await exchangeCode(ctx, "refresh-verifier-123456789012345678901234567890123");

  const rotated = await postForm(ctx, "/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: initial.refresh_token,
    client_id: "client-1",
  });
  assert.equal(rotated.statusCode, 200);
  const second = rotated.json() as TokenJson;
  assert.notEqual(second.refresh_token, initial.refresh_token);

  const replay = await postForm(ctx, "/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: initial.refresh_token,
    client_id: "client-1",
  });
  assert.equal(replay.statusCode, 400);
  assert.equal((replay.json() as ErrorJson).error.code, "invalid_grant");

  const afterReplay = await postForm(ctx, "/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: second.refresh_token,
    client_id: "client-1",
  });
  assert.equal(afterReplay.statusCode, 400);
  assert.equal((afterReplay.json() as ErrorJson).error.code, "invalid_grant");
  assert.equal(ctx.store.revokedFamilyCount(), 1);
  await ctx.app.close();
});

test("PKCE rejects a too-short verifier (RFC 7636 requires 43-128 chars)", async () => {
  const ctx = await setup();
  const approved = await approveCode(ctx, "valid-verifier-123456789012345678901234567890123", "fetch:read");
  const bad = await postForm(ctx, "/oauth/token", {
    grant_type: "authorization_code",
    code: approved.code,
    redirect_uri: REDIRECT,
    client_id: "client-1",
    code_verifier: "x", // 1 char — RFC 7636 §4.1 requires 43-128
  });
  assert.equal(bad.statusCode, 400);
  assert.equal((bad.json() as ErrorJson).error.code, "invalid_grant");
  await ctx.app.close();
});

test("refresh with a mismatched client_id is rejected and revokes the family (RFC 6749 §6)", async () => {
  const ctx = await setup();
  const initial = await exchangeCode(ctx, "refresh-verifier-123456789012345678901234567890123");
  // The token is bound to client-1; rotating with a different client_id is theft/replay.
  const mismatched = await postForm(ctx, "/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: initial.refresh_token,
    client_id: "client-2",
  });
  assert.equal(mismatched.statusCode, 400);
  assert.equal((mismatched.json() as ErrorJson).error.code, "invalid_grant");
  // The mismatch revoked the family, so even the legitimate client can no longer use it.
  const legit = await postForm(ctx, "/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: initial.refresh_token,
    client_id: "client-1",
  });
  assert.equal(legit.statusCode, 400);
  await ctx.app.close();
});

test("hosted production requires secrets while local binary auth bypass needs none", async () => {
  assert.throws(
    () => loadAuthRuntimeConfig({
      SMART_FETCH_FLAVOR: "hosted",
      NODE_ENV: "production",
      OAUTH_ISSUER: "https://smart-fetch.test",
      OAUTH_RESOURCE: "https://smart-fetch.test/mcp",
    }),
    /OAUTH_CONSENT_SIGNING_SECRET and OAUTH_SIGNING_PRIVATE_JWK/,
  );
  assert.deepEqual(loadAuthRuntimeConfig({ SMART_FETCH_FLAVOR: "local-binary", NODE_ENV: "production" }), {
    flavor: "local-binary",
  });

  const audit = new MemoryAudit();
  const auth = await createRequestAuthorizer({
    runtime: { flavor: "local-binary" },
    clock: new FakeClock(NOW_MS),
    audit,
  }).authorize({ requiredScope: "fetch:transform" });
  assert.equal(auth.localBypass, true);
  assert.deepEqual(auth.scopes, ["fetch:read", "fetch:transform"]);
});

test("scope helpers enforce read versus transform", () => {
  assert.equal(requiredScopeForSmartFetch({ output: "raw" }), "fetch:read");
  assert.equal(requiredScopeForSmartFetch({ output: "summary" }), "fetch:transform");
  assert.equal(requiredScopeForSmartFetch({}), "fetch:transform");
  assert.throws(
    () => requireScope({ subject: "s", clientId: "c", scopes: ["fetch:read"] }, "fetch:transform"),
    /Missing required scope: fetch:transform/,
  );
});

async function setup(): Promise<TestContext> {
  const app = Fastify();
  const clock = new FakeClock(NOW_MS);
  const store = new MemoryStore();
  const audit = new MemoryAudit();
  const config = hostedConfig();
  await registerOAuthRoutes(app, { config, store, clock, audit });
  return { app, clock, store, audit, config };
}

async function approveCode(ctx: TestContext, verifier: string, scope: string): Promise<{ code: string }> {
  const authorize = await ctx.app.inject({
    method: "GET",
    url: "/oauth/authorize",
    query: {
      response_type: "code",
      client_id: "client-1",
      redirect_uri: REDIRECT,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      scope,
      state: "state-1",
    },
  });
  assert.equal(authorize.statusCode, 200);
  const cookie = firstCookie(authorize.headers["set-cookie"]);
  assert.match(cookie, /^smart_fetch_consent=/);

  const approve = await ctx.app.inject({
    method: "POST",
    url: "/oauth/authorize/approve",
    headers: { cookie },
    payload: { approved: true },
  });
  assert.equal(approve.statusCode, 302);
  const location = new URL(String(approve.headers.location));
  assert.equal(`${location.protocol}//${location.host}${location.pathname}`, REDIRECT);
  assert.equal(location.searchParams.get("iss"), ctx.config.issuer);
  assert.equal(location.searchParams.get("state"), "state-1");
  const code = location.searchParams.get("code");
  assert.ok(code);
  return { code };
}

async function exchangeCode(ctx: TestContext, verifier: string): Promise<TokenJson> {
  const approved = await approveCode(ctx, verifier, "fetch:read fetch:transform");
  const response = await postForm(ctx, "/oauth/token", {
    grant_type: "authorization_code",
    code: approved.code,
    redirect_uri: REDIRECT,
    client_id: "client-1",
    code_verifier: verifier,
  });
  assert.equal(response.statusCode, 200);
  return response.json() as TokenJson;
}

async function postForm(ctx: TestContext, url: string, body: Record<string, string>) {
  return await ctx.app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(body).toString(),
  });
}

function hostedConfig(): HostedOAuthConfig {
  return {
    issuer: "https://smart-fetch.test",
    resource: "https://smart-fetch.test/mcp",
    consentSigningSecret: "test-consent-secret-with-enough-entropy",
    signingPrivateJwk: testPrivateJwk(),
    signingKeyId: "test-key-1",
    redirectAllowlist: [REDIRECT],
    accessTokenTtlSeconds: 600,
    refreshTokenTtlSeconds: 2_592_000,
    consentTokenTtlSeconds: 300,
    authorizationCodeTtlSeconds: 300,
  };
}

function testPrivateJwk(): JWK {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { ...privateKey.export({ format: "jwk" }), alg: "ES256", kid: "test-key-1" } as JWK;
}

function firstCookie(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  assert.ok(raw);
  return raw.split(";")[0] ?? raw;
}

function assertNoRawSecrets(serialized: string, values: string[]): void {
  for (const value of values) assert.equal(serialized.includes(value), false, `raw secret leaked: ${value}`);
}

class FakeClock implements ClockPort {
  private ms: number;
  constructor(ms: number) { this.ms = ms; }
  nowMs(): number { return this.ms; }
  advance(ms: number): void { this.ms += ms; }
}

class MemoryAudit implements AuditLoggerPort {
  readonly events: AuthAuditEvent[] = [];
  async writeAuthEvent(event: AuthAuditEvent): Promise<void> { this.events.push(event); }
}

class MemoryStore implements StorePort {
  readonly authCodes = new Map<string, AuthCodeRecord>();
  readonly refreshTokens = new Map<string, RefreshTokenRecord & { consumedAt: string | null }>();
  readonly families = new Map<string, string | null>();

  async saveAuthCode(input: SaveAuthCodeInput): Promise<void> { this.authCodes.set(input.codeHash, { ...input }); }
  async consumeAuthCode(codeHash: string, nowIso: string): Promise<AuthCodeRecord | null> {
    const record = this.authCodes.get(codeHash) ?? null;
    this.authCodes.delete(codeHash);
    return record && record.expiresAt > nowIso ? record : null;
  }
  async saveRefreshToken(input: SaveRefreshTokenInput): Promise<void> {
    this.families.set(input.familyId, this.families.get(input.familyId) ?? null);
    this.refreshTokens.set(input.tokenHash, { ...input, consumedAt: null });
  }
  async rotateRefreshToken(tokenHash: string, next: SaveRefreshTokenInput, nowIso: string) {
    const current = this.refreshTokens.get(tokenHash) ?? null;
    if (!current || this.families.get(current.familyId)) return null;
    if (current.consumedAt) { await this.revokeRefreshTokenFamily(current.familyId, nowIso); return null; }
    if (current.expiresAt <= nowIso || next.familyId !== current.familyId) return null;
    current.consumedAt = nowIso;
    await this.saveRefreshToken({ ...next, clientId: current.clientId, subject: current.subject, scopes: current.scopes });
    return current;
  }
  async revokeRefreshTokenFamily(familyId: string, revokedAtIso: string): Promise<void> { this.families.set(familyId, revokedAtIso); }
  async findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null> { return this.refreshTokens.get(tokenHash) ?? null; }
  async close(): Promise<void> {}
  snapshot(): string {
    return JSON.stringify({ codes: [...this.authCodes], refresh: [...this.refreshTokens], families: [...this.families] });
  }
  revokedFamilyCount(): number { return [...this.families.values()].filter(Boolean).length; }
}

interface TestContext {
  app: Awaited<ReturnType<typeof Fastify>>;
  clock: FakeClock;
  store: MemoryStore;
  audit: MemoryAudit;
  config: HostedOAuthConfig;
}

interface TokenJson {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface ErrorJson {
  error: { code: string; message: string };
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, importJWK, jwtVerify } from "jose";
import type { JWK, JWTPayload } from "jose";
import type { ClockPort } from "../ports/clock.ts";
import type { HostedOAuthConfig } from "./oauth-config.ts";
import type { OAuthScope } from "./oauth-scopes.ts";
import { scopeString } from "./oauth-scopes.ts";
import { OAuthError } from "./oauth-errors.ts";

const CONSENT_AUDIENCE = "smart-fetch/oauth-consent";
const CODE_PREFIX = "sfac";
const REFRESH_PREFIX = "sfrt";

export interface ConsentRequestClaims {
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: OAuthScope[];
  codeChallenge: string;
  codeChallengeMethod: "S256";
  state?: string;
}

export interface AccessTokenClaims {
  subject: string;
  clientId: string;
  scopes: OAuthScope[];
}

export interface VerifiedAccessToken {
  subject: string;
  clientId: string;
  scopes: OAuthScope[];
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateAuthorizationCode(): string {
  return `${CODE_PREFIX}_${base64url(randomBytes(32))}`;
}

export function generateRefreshFamilyId(): string {
  return base64url(randomBytes(18));
}

export function generateRefreshToken(familyId: string = generateRefreshFamilyId()): string {
  return `${REFRESH_PREFIX}.${familyId}.${base64url(randomBytes(32))}`;
}

export function parseRefreshFamilyId(refreshToken: string): string | null {
  const parts = refreshToken.split(".");
  if (parts.length !== 3 || parts[0] !== REFRESH_PREFIX) return null;
  return /^[A-Za-z0-9_-]{16,}$/.test(parts[1] ?? "") ? parts[1] : null;
}

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const actual = pkceChallenge(verifier);
  const left = Buffer.from(actual);
  const right = Buffer.from(challenge);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export async function signConsentToken(
  claims: ConsentRequestClaims,
  config: HostedOAuthConfig,
  clock: ClockPort,
): Promise<string> {
  const now = nowSeconds(clock);
  return await new SignJWT({
    typ: "smart-fetch-consent",
    client_id: claims.clientId,
    redirect_uri: claims.redirectUri,
    resource: claims.resource,
    scope: scopeString(claims.scopes),
    code_challenge: claims.codeChallenge,
    code_challenge_method: claims.codeChallengeMethod,
    state: claims.state,
  }).setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(config.issuer)
    .setAudience(CONSENT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + config.consentTokenTtlSeconds)
    .sign(consentSecret(config));
}

export async function verifyConsentToken(
  token: string,
  config: HostedOAuthConfig,
  clock?: ClockPort,
): Promise<ConsentRequestClaims> {
  try {
    const { payload } = await jwtVerify(token, consentSecret(config), {
      issuer: config.issuer,
      audience: CONSENT_AUDIENCE,
      currentDate: clock ? new Date(clock.nowMs()) : undefined,
    });
    return consentClaims(payload);
  } catch {
    throw new OAuthError("invalid_consent", "Consent token is invalid or expired");
  }
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  config: HostedOAuthConfig,
  clock: ClockPort,
): Promise<string> {
  const now = nowSeconds(clock);
  const key = await importJWK(config.signingPrivateJwk, "ES256");
  return await new SignJWT({
    client_id: claims.clientId,
    scope: scopeString(claims.scopes),
  }).setProtectedHeader({ alg: "ES256", kid: keyId(config), typ: "JWT" })
    .setIssuer(config.issuer)
    .setSubject(claims.subject)
    .setAudience(config.resource)
    .setIssuedAt(now)
    .setExpirationTime(now + config.accessTokenTtlSeconds)
    .sign(key);
}

export async function verifyAccessToken(
  token: string,
  config: HostedOAuthConfig,
  clock?: ClockPort,
): Promise<VerifiedAccessToken> {
  try {
    const key = await importJWK(publicJwk(config), "ES256");
    const { payload } = await jwtVerify(token, key, {
      issuer: config.issuer,
      audience: config.resource,
      currentDate: clock ? new Date(clock.nowMs()) : undefined,
    });
    return accessClaims(payload);
  } catch {
    throw new OAuthError("invalid_token", "Bearer token is invalid", 401);
  }
}

export function publicJwk(config: HostedOAuthConfig): JWK {
  const jwk = config.signingPrivateJwk;
  const kid = keyId(config);
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, alg: "ES256", use: "sig", kid };
}

export function expiresAtIso(clock: ClockPort, ttlSeconds: number): string {
  return new Date(clock.nowMs() + ttlSeconds * 1000).toISOString();
}

function consentSecret(config: HostedOAuthConfig): Uint8Array {
  return new TextEncoder().encode(config.consentSigningSecret);
}

function keyId(config: HostedOAuthConfig): string | undefined {
  return config.signingKeyId ?? stringClaim(config.signingPrivateJwk.kid);
}

function consentClaims(payload: JWTPayload): ConsentRequestClaims {
  const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
  if (payload.typ !== "smart-fetch-consent") throw new Error("wrong token type");
  return {
    clientId: requiredString(payload.client_id, "client_id"),
    redirectUri: requiredString(payload.redirect_uri, "redirect_uri"),
    resource: requiredString(payload.resource, "resource"),
    scopes: scopes as OAuthScope[],
    codeChallenge: requiredString(payload.code_challenge, "code_challenge"),
    codeChallengeMethod: "S256",
    state: stringClaim(payload.state),
  };
}

function accessClaims(payload: JWTPayload): VerifiedAccessToken {
  return {
    subject: requiredString(payload.sub, "sub"),
    clientId: requiredString(payload.client_id, "client_id"),
    scopes: typeof payload.scope === "string" ? payload.scope.split(/\s+/) as OAuthScope[] : [],
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value === "string" && value) return value;
  throw new Error(`missing ${label}`);
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function nowSeconds(clock: ClockPort): number {
  return Math.floor(clock.nowMs() / 1000);
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

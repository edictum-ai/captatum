import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";

/**
 * Verifies a Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) so the OAuth
 * subject is the real authenticated email, not a hardcoded placeholder. Ported
 * from personal-memory-gateway. RS256 against Cloudflare's public JWKS with
 * audience + issuer + expiry checked in code. The email ALLOWLIST (which emails
 * may mint a token) is enforced by the Cloudflare Zero Trust Access application
 * policy — the single source of truth — NOT by this verifier; an optional
 * CF_ACCESS_EMAIL_ALLOWLIST adds a defense-in-depth second gate here (#9).
 */
export interface CloudflareAccessJwtConfig {
  audience: string;
  certsUrl: string;
  issuer: string;
  /** Optional defense-in-depth email allowlist. Empty/undefined delegates WHO is
   *  allowed entirely to the CF Zero Trust app policy (the default behavior). */
  emailAllowlist?: string[];
}

export interface VerifiedCloudflareAccessJwt {
  audience: string;
  email: string;
  expiresAt: number;
  issuedAt?: number;
  subject: string;
}

type AccessJwtPayload = JWTPayload & { email?: string };

export type JwtVerifyResult =
  | { ok: true; claims: VerifiedCloudflareAccessJwt }
  | { ok: false; reason: string };

export function createCloudflareAccessJwtVerifier(config: CloudflareAccessJwtConfig) {
  const jwks = createRemoteJWKSet(new URL(config.certsUrl), { cacheMaxAge: 5 * 60 * 1000 });

  return async (token: string): Promise<JwtVerifyResult> => {
    try {
      const result = await jwtVerify<AccessJwtPayload>(token, jwks, {
        algorithms: ["RS256"],
        audience: config.audience,
        clockTolerance: 60,
        issuer: config.issuer,
      });
      return validateClaims(result.payload, config);
    } catch (error) {
      return { ok: false, reason: jwtErrorReason(error) };
    }
  };
}

export function validateClaims(payload: AccessJwtPayload, config: CloudflareAccessJwtConfig): JwtVerifyResult {
  if (!payload.exp) return { ok: false, reason: "access_jwt_missing_expiry" };
  // Signature/audience/issuer/expiry were already checked by jwtVerify in the caller.
  // The email ALLOWLIST (WHO may mint a token) is the Cloudflare Zero Trust app
  // policy's job by default; an optional CF_ACCESS_EMAIL_ALLOWLIST (#9) adds a
  // defense-in-depth second gate here. Exported so the gate is unit-testable without
  // the JWKS network fetch.
  if (!payload.email) return { ok: false, reason: "access_jwt_email_not_allowed" };
  if (config.emailAllowlist && config.emailAllowlist.length > 0 && !emailAllowed(payload.email, config.emailAllowlist)) {
    return { ok: false, reason: "access_jwt_email_not_allowed" };
  }
  return {
    ok: true,
    claims: {
      audience: config.audience,
      email: payload.email,
      expiresAt: payload.exp,
      issuedAt: payload.iat,
      subject: payload.sub ?? payload.email,
    },
  };
}

/** Case-insensitive, whitespace-trimmed email membership test. Exported so the
 *  defense-in-depth gate is unit-testable without the JWKS network call. */
export function emailAllowed(email: string, allowlist: string[]): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return allowlist.some((entry) => entry.trim().toLowerCase() === normalized);
}

function jwtErrorReason(error: unknown): string {
  if (error instanceof errors.JWTExpired) return "access_jwt_expired";
  if (error instanceof errors.JWTClaimValidationFailed) return "access_jwt_bad_claim";
  if (error instanceof errors.JOSEAlgNotAllowed) return "access_jwt_unsupported_alg";
  if (error instanceof errors.JWKSNoMatchingKey) return "access_jwt_unknown_key";
  if (error instanceof errors.JOSEError) return "access_jwt_invalid";
  return "access_jwt_verify_failed";
}

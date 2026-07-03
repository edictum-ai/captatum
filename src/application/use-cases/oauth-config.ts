import type { JWK } from "jose";
import { config } from "../../config.ts";

export type DeploymentFlavor = "hosted" | "local-binary";

export interface HostedOAuthConfig {
  issuer: string;
  resource: string;
  consentSigningSecret: string;
  signingPrivateJwk: JWK;
  signingKeyId?: string;
  redirectAllowlist: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  consentTokenTtlSeconds: number;
  authorizationCodeTtlSeconds: number;
}

export type AuthRuntimeConfig =
  | { flavor: "local-binary" }
  | { flavor: "hosted"; oauth: HostedOAuthConfig };

export class AuthConfigError extends Error {
  readonly code = "invalid_auth_config";
}

export function loadAuthRuntimeConfig(env: NodeJS.ProcessEnv = process.env): AuthRuntimeConfig {
  const flavor = readFlavor(env);
  if (flavor === "local-binary") return { flavor };
  assertHostedProductionSecrets(env);
  assertHostedCloudflareAccess(env);
  return { flavor, oauth: readHostedOAuthConfig(env) };
}

export function assertHostedProductionSecrets(env: NodeJS.ProcessEnv = process.env): void {
  if (readFlavor(env) !== "hosted") return;
  const missing = [
    ["OAUTH_CONSENT_SIGNING_SECRET", env.OAUTH_CONSENT_SIGNING_SECRET],
    ["OAUTH_SIGNING_PRIVATE_JWK", env.OAUTH_SIGNING_PRIVATE_JWK],
    ["OAUTH_ISSUER", env.OAUTH_ISSUER],
    ["OAUTH_RESOURCE", env.OAUTH_RESOURCE],
  ].filter(([, value]) => !value || !value.trim()).map(([name]) => name);
  if (missing.length) {
    throw new AuthConfigError(`Hosted requires ${missing.join(" and ")}`);
  }
  // OAUTH-5: validate secret length + JWK shape so a misconfigured boot fails
  // closed, not silently. jose rejects zero-length keys, but we don't want to
  // depend on that across upgrades.
  const consentSecret = env.OAUTH_CONSENT_SIGNING_SECRET ?? "";
  if (consentSecret.trim().length < 32) {
    throw new AuthConfigError("OAUTH_CONSENT_SIGNING_SECRET must be at least 32 characters");
  }
  const jwk = parsePrivateJwk(env.OAUTH_SIGNING_PRIVATE_JWK ?? "");
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.x || !jwk.y) {
    throw new AuthConfigError("OAUTH_SIGNING_PRIVATE_JWK must be an EC P-256 key with d, x, y");
  }
  // #6: validate issuer (absolute https URL) + resource (absolute http(s) URL) so a
  // hosted boot with these unset/garbage fails closed. The raw `https://` prefix check
  // rejects inputs Node's lenient URL parser would normalize (e.g. `https:/host`).
  if (!/^https:\/\//i.test(env.OAUTH_ISSUER ?? "")) {
    throw new AuthConfigError("OAUTH_ISSUER must be an absolute https URL");
  }
  parseAbsoluteUrl(env.OAUTH_ISSUER ?? "", "OAUTH_ISSUER");
  if (!/^https?:\/\//i.test(env.OAUTH_RESOURCE ?? "")) {
    throw new AuthConfigError("OAUTH_RESOURCE must be an absolute http(s) URL");
  }
  parseAbsoluteUrl(env.OAUTH_RESOURCE ?? "", "OAUTH_RESOURCE");
}

/** AUTH-1/CONFIG-2: the hosted flavor MUST sit behind Cloudflare Access. A hosted
 * boot missing CF_ACCESS_ENABLED=true + audience/certs/issuer fails closed here,
 * rather than silently degrading the OAuth subject to a placeholder identity. */
function assertHostedCloudflareAccess(env: NodeJS.ProcessEnv): void {
  const enabled = (env.CF_ACCESS_ENABLED ?? "false") === "true";
  const audience = env.CF_ACCESS_AUDIENCE?.trim();
  const certsUrl = env.CF_ACCESS_CERTS_URL?.trim();
  const issuer = env.CF_ACCESS_ISSUER?.trim();
  if (!enabled || !audience || !certsUrl || !issuer) {
    throw new AuthConfigError(
      "Hosted flavor requires Cloudflare Access: CF_ACCESS_ENABLED=true plus CF_ACCESS_AUDIENCE, CF_ACCESS_CERTS_URL, CF_ACCESS_ISSUER",
    );
  }
  // The JWKS fetch (CF_ACCESS_CERTS_URL) is the inbound-auth trust root — require
  // https so a network MITM cannot substitute their own RSA key into the JWKS response
  // and then sign a Cf-Access-Jwt-Assertion as any identity (total auth bypass).
  if (!/^https:\/\//i.test(certsUrl)) {
    throw new AuthConfigError("CF_ACCESS_CERTS_URL must be an absolute https URL");
  }
  if (!/^https:\/\//i.test(issuer)) {
    throw new AuthConfigError("CF_ACCESS_ISSUER must be an absolute https URL");
  }
}

function readHostedOAuthConfig(env: NodeJS.ProcessEnv): HostedOAuthConfig {
  const issuer = envString(env, "OAUTH_ISSUER", "");
  const resource = envString(env, "OAUTH_RESOURCE", "");
  const consentSigningSecret = envString(
    env,
    "OAUTH_CONSENT_SIGNING_SECRET",
    "",
  );
  const signingPrivateJwk = parsePrivateJwk(envString(
    env,
    "OAUTH_SIGNING_PRIVATE_JWK",
    "",
  ));
  return {
    issuer,
    resource,
    consentSigningSecret,
    signingPrivateJwk,
    signingKeyId: envString(env, "OAUTH_SIGNING_KEY_ID", "") || undefined,
    redirectAllowlist: envString(env, "OAUTH_REDIRECT_ALLOWLIST", "")
      .split(",").map((item) => item.trim()).filter(Boolean),
    accessTokenTtlSeconds: config.oauth.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.oauth.refreshTokenTtlSeconds,
    consentTokenTtlSeconds: config.oauth.consentTokenTtlSeconds,
    authorizationCodeTtlSeconds: config.oauth.authorizationCodeTtlSeconds,
  };
}

function readFlavor(env: NodeJS.ProcessEnv): DeploymentFlavor {
  const raw = env.CAPTATUM_FLAVOR ?? env.DEPLOYMENT_FLAVOR ?? "local-binary";
  if (raw === "hosted" || raw === "local-binary") return raw;
  throw new AuthConfigError("CAPTATUM_FLAVOR must be hosted or local-binary");
}

function envString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  return value && value.trim() ? value : fallback;
}

function parsePrivateJwk(raw: string): JWK {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as JWK;
  } catch (error) {
    throw new AuthConfigError(`OAUTH_SIGNING_PRIVATE_JWK must be valid JSON: ${message(error)}`);
  }
}

function parseAbsoluteUrl(raw: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AuthConfigError(`${label} must be an absolute URL`);
  }
  if (!parsed.protocol || !parsed.host) {
    throw new AuthConfigError(`${label} must be an absolute URL`);
  }
  return parsed;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "parse failed";
}

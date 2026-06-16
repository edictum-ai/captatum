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
  return { flavor, oauth: readHostedOAuthConfig(env) };
}

export function assertHostedProductionSecrets(env: NodeJS.ProcessEnv = process.env): void {
  if (readFlavor(env) !== "hosted" || env.NODE_ENV !== "production") return;
  const missing = [
    ["OAUTH_CONSENT_SIGNING_SECRET", env.OAUTH_CONSENT_SIGNING_SECRET],
    ["OAUTH_SIGNING_PRIVATE_JWK", env.OAUTH_SIGNING_PRIVATE_JWK],
  ].filter(([, value]) => !value || !value.trim()).map(([name]) => name);
  if (missing.length) {
    throw new AuthConfigError(`Hosted production requires ${missing.join(" and ")}`);
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
  const raw = env.SMART_FETCH_FLAVOR ?? env.DEPLOYMENT_FLAVOR ?? "local-binary";
  if (raw === "hosted" || raw === "local-binary") return raw;
  throw new AuthConfigError("SMART_FETCH_FLAVOR must be hosted or local-binary");
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : "parse failed";
}

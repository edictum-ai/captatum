// Captatum auth composition for the mcp-sso library (hosted flavor). captatum's own
// OAuth 2.1 / DCR / PKCE / Cloudflare-Access stack was extracted into the owner's OSS
// library `mcp-sso` (acartag7/mcp-sso); this module is the captatum-side wiring that
// builds a validated mcp-sso `BridgeConfig` from captatum env + keeps captatum's
// deployment-flavor resolution and Cloudflare-Access-required boot gate. The OAuth
// mechanics (token signing/verification, DCR, consent, scope enforcement, the AS/PRM
// metadata, the store schema) live in the library — captatum owns only its scope
// policy (fetch:read / fetch:transform) and the hosted-vs-local boundary.
//
// This replaces the removed `oauth-config.ts`. `mcp-sso`'s `createBridgeConfig` is the
// fail-closed boot gate for the OAuth material itself (https issuer+resource, EC P-256
// signing key, ≥32-char consent secret, valid TTLs) — captatum no longer re-implements
// that validation. captatum DOES keep its Cloudflare-Access-required gate (AUTH-1): the
// hosted flavor MUST sit behind CF Access, so the OAuth subject is a real verified
// identity, never a placeholder.

import type { JWK } from "jose";
import {
  AuthConfigError,
  createBridgeConfig,
  type BridgeConfig,
} from "mcp-sso";
import { config } from "../config.ts";
import { OAUTH_SCOPES } from "./scopes.ts";

export type DeploymentFlavor = "hosted" | "local-binary";

/** Resolved auth runtime. The hosted branch carries a validated, frozen `BridgeConfig`
 *  (the library's `createBridgeConfig` object); the local-binary branch carries nothing
 *  — it has no OAuth boundary and runs over stdio via `LocalBypassAuthorizer`. */
export interface CaptatumAuthRuntime {
  flavor: DeploymentFlavor;
  /** Present iff `flavor === "hosted"`: the validated + frozen mcp-sso BridgeConfig. */
  readonly config?: BridgeConfig;
}

/** Resolve the auth runtime from env. Hosted ⇒ boot-gate Cloudflare Access, then build +
 *  validate the mcp-sso BridgeConfig. Local-binary ⇒ no OAuth state. */
export function loadCaptatumAuth(env: NodeJS.ProcessEnv = process.env): CaptatumAuthRuntime {
  const flavor = readFlavor(env);
  if (flavor === "local-binary") return { flavor };
  assertHostedCloudflareAccess(env);
  return { flavor, config: createMcpSsoConfig(env) };
}

/** Read + validate the deployment flavor. Defaults to the single-user local-binary
 *  flavor; only an explicit `hosted` opts into the OAuth boundary. */
export function readFlavor(env: NodeJS.ProcessEnv = process.env): DeploymentFlavor {
  const raw = env.CAPTATUM_FLAVOR ?? env.DEPLOYMENT_FLAVOR ?? "local-binary";
  if (raw === "hosted" || raw === "local-binary") return raw;
  throw new AuthConfigError("CAPTATUM_FLAVOR must be hosted or local-binary");
}

/** Build + validate the mcp-sso `BridgeConfig` from captatum env. Throws `AuthConfigError`
 *  (fail-closed) on any missing/invalid value — `createBridgeConfig` is the authority for
 *  the OAuth-material shape (https, EC P-256, secret length, TTLs, scope subset). */
export function createMcpSsoConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return createBridgeConfig({
    issuer: mustEnv(env, "OAUTH_ISSUER"),
    resource: mustEnv(env, "OAUTH_RESOURCE"),
    consentSigningSecret: mustEnv(env, "OAUTH_CONSENT_SIGNING_SECRET"),
    signingPrivateJwk: parsePrivateJwk(mustEnv(env, "OAUTH_SIGNING_PRIVATE_JWK")),
    signingKeyId: envString(env, "OAUTH_SIGNING_KEY_ID") || undefined,
    redirectAllowlist: listEnv(env, "OAUTH_REDIRECT_ALLOWLIST"),
    // captatum's scope policy (single source of truth: src/application/scopes.ts):
    // fetch:read (raw) + fetch:transform (summary/extract); raw is the zero-config
    // default (a no-transform call only needs fetch:read).
    scopeCatalog: [...OAUTH_SCOPES],
    defaultScopes: [OAUTH_SCOPES[0]],
    allowedOrigins: listEnv(env, "MCP_ALLOWED_ORIGINS"),
    dcr: { mode: "stateless" },
    dev: envString(env, "OAUTH_ALLOW_INSECURE_LOCALHOST") === "true"
      ? { allowInsecureLocalhost: true }
      : undefined,
    accessTokenTtlSeconds: config.oauth.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.oauth.refreshTokenTtlSeconds,
    consentTokenTtlSeconds: config.oauth.consentTokenTtlSeconds,
    authorizationCodeTtlSeconds: config.oauth.authorizationCodeTtlSeconds,
  });
}

/** AUTH-1/CONFIG-2: the hosted flavor MUST sit behind Cloudflare Access. A hosted boot
 *  missing CF_ACCESS_ENABLED=true + audience/certs/issuer fails closed here, rather than
 *  silently degrading the OAuth subject to a placeholder identity. mcp-sso's CF identity
 *  port additionally enforces audience-non-empty + https certs/issuer at construction;
 *  this gate runs first (before any library object is built) so a misconfigured boot
 *  never reaches a half-built bridge. */
export function assertHostedCloudflareAccess(env: NodeJS.ProcessEnv = process.env): void {
  const enabled = (env.CF_ACCESS_ENABLED ?? "false") === "true";
  const audience = env.CF_ACCESS_AUDIENCE?.trim();
  const certsUrl = env.CF_ACCESS_CERTS_URL?.trim();
  const issuer = env.CF_ACCESS_ISSUER?.trim();
  if (!enabled || !audience || !certsUrl || !issuer) {
    throw new AuthConfigError(
      "Hosted flavor requires Cloudflare Access: CF_ACCESS_ENABLED=true plus CF_ACCESS_AUDIENCE, CF_ACCESS_CERTS_URL, CF_ACCESS_ISSUER",
    );
  }
  // The JWKS fetch (CF_ACCESS_CERTS_URL) is the inbound-auth trust root — require https so
  // a network MITM cannot substitute its own RSA key into the JWKS response and then sign
  // a Cf-Access-Jwt-Assertion as any identity (total auth bypass).
  assertHttpsUrl(certsUrl, "CF_ACCESS_CERTS_URL");
  assertHttpsUrl(issuer, "CF_ACCESS_ISSUER");
}

function assertHttpsUrl(raw: string, label: string): void {
  // Raw `^https://` prefix check before `new URL()` — Node's parser normalizes `https:/host`.
  if (!/^https:\/\//i.test(raw)) {
    throw new AuthConfigError(`${label} must be an absolute https URL`);
  }
  try {
    const parsed = new URL(raw);
    if (!parsed.protocol || !parsed.host) throw new Error("not absolute");
  } catch {
    throw new AuthConfigError(`${label} must be an absolute https URL`);
  }
}

function mustEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || !value.trim()) throw new AuthConfigError(`Hosted requires ${name}`);
  return value;
}

function envString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  return value && value.trim() ? value : "";
}

function listEnv(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function parsePrivateJwk(raw: string): JWK {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as JWK;
  } catch (error) {
    throw new AuthConfigError(
      `OAUTH_SIGNING_PRIVATE_JWK must be valid JSON: ${error instanceof Error ? error.message : "parse failed"}`,
    );
  }
}

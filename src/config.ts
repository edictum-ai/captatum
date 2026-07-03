import { isLoopbackHost } from "./domain/policy.ts";

export const config = {
  source: {
    maxFileLines: 250,
  },
  http: {
    host: () => envString("HOST", "127.0.0.1"),
    port: () => envPositiveInteger("PORT", 3000),
    bodyLimitBytes: 5 * 1024 * 1024,
  },
  mcp: {
    endpointPath: "/mcp",
    stableProtocolVersion: "2025-11-25",
    forwardDesignVersion: "2026-07-28",
    allowedHosts: () => envList("MCP_ALLOWED_HOSTS"),
    allowedOrigins: () => envList("MCP_ALLOWED_ORIGINS"),
    /** #45: "clientId=profile,..." mapping for client-aware output shaping (parsed by
     *  src/application/client-profile.ts). Unknown clientIds → the default shape. */
    clientProfiles: () => envString("CAPTATUM_CLIENT_PROFILES", ""),
  },
  cloudflareAccess: {
    enabled: () => envString("CF_ACCESS_ENABLED", "false") === "true",
    audience: () => envString("CF_ACCESS_AUDIENCE", ""),
    certsUrl: () => envString("CF_ACCESS_CERTS_URL", ""),
    issuer: () => envString("CF_ACCESS_ISSUER", ""),
    /** #9: optional defense-in-depth email allowlist for the CF Access JWT verifier.
     *  Empty (default) delegates WHO is allowed to the CF Zero Trust app policy. */
    emailAllowlist: () => envList("CF_ACCESS_EMAIL_ALLOWLIST"),
  },
  deployment: {
    flavor: () => envString("CAPTATUM_FLAVOR", envString("DEPLOYMENT_FLAVOR", "local-binary")),
    production: () => envString("NODE_ENV", "development") === "production",
  },
  oauth: {
    issuer: () => envString("OAUTH_ISSUER", ""),
    resource: () => envString("OAUTH_RESOURCE", ""),
    consentSigningSecret: () => envString("OAUTH_CONSENT_SIGNING_SECRET", ""),
    signingPrivateJwk: () => envString("OAUTH_SIGNING_PRIVATE_JWK", ""),
    signingKeyId: () => envString("OAUTH_SIGNING_KEY_ID", ""),
    accessTokenTtlSeconds: 600,
    refreshTokenTtlSeconds: 2592000,
    consentTokenTtlSeconds: 300,
    authorizationCodeTtlSeconds: 300,
    redirectAllowlist: () => envString("OAUTH_REDIRECT_ALLOWLIST", "").split(",").map((s) => s.trim()).filter(Boolean),
  },
  transform: {
    openRouterApiKey: () => envString("OPENROUTER_API_KEY", ""),
    openRouterBaseUrl: () => envString("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    openRouterModels: () => envString(
      "OPENROUTER_MODELS",
      // Primary = deepseek-v4-flash (cheap, 1M context). Fallback = qwen3.6-flash —
      // a DIFFERENT lab (Alibaba) so a DeepSeek upstream outage doesn't take down
      // the fallback too; flash-tier (cheap), 1M context, current (2026-04-27). NOT
      // openrouter/auto (unpredictable routing → garbage) and not a stale model.
      "deepseek/deepseek-v4-flash,qwen/qwen3.6-flash",
    ),
    ollamaBaseUrl: () => {
      const url = envString("OLLAMA_BASE_URL", "");
      if (url) {
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "https:" && !isLoopbackHost(parsed.hostname)) {
            throw new Error(`OLLAMA_BASE_URL must be https (or loopback): ${url}`);
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("OLLAMA_BASE_URL")) throw e;
          throw new Error(`OLLAMA_BASE_URL is not a valid URL: ${url}`);
        }
      }
      return url;
    },
    ollamaModel: () => envString("OLLAMA_MODEL", "llama3.1"),
    timeoutMs: () => envPositiveInteger("TRANSFORM_TIMEOUT_MS", 45000),
    /** #3: default output-token cap when the caller omits `budget` (bounds paid
     *  generation per call). Clamped upstream to MAX_OUTPUT_TOKENS_CAP. */
    maxOutputTokensDefault: () => envPositiveInteger("TRANSFORM_MAX_OUTPUT_TOKENS", 2000),
    freeFirst: true,
  },
  render: {
    allowRenderDefault: false,
    timeoutMs: 20000,
    /** CDP endpoint of a browser sidecar (e.g. "http://localhost:9222"). If set, Tier-3 connects to a Chromium in its own container instead of launching one in-process (blast-radius separation). */
    cdpEndpoint: () => envString("CAPTATUM_BROWSER_CDP_ENDPOINT", ""),
    /** Chromium sandbox for in-process launch (default true — threat model: never --no-sandbox). Only relevant when no sidecar is configured. */
    chromiumSandbox: () => envString("CAPTATUM_BROWSER_INPROCESS_SANDBOX", "true") === "true",
    /** DOS-2: max concurrent Tier-3 renders. Chromium is the expensive resource, so
     * bound it independently of the global admission cap (default 2). */
    maxConcurrentRenders: () => envPositiveInteger("CAPTATUM_MAX_CONCURRENT_RENDERS", 2),
  },
  tidb: {
    host: () => envString("TIDB_HOST", ""),
    port: () => envPositiveInteger("TIDB_PORT", 4000),
    database: () => envString("TIDB_DATABASE", "captatum"),
    user: () => envString("TIDB_USER", ""),
    password: () => envString("TIDB_PASSWORD", ""),
    sslCa: () => envString("TIDB_SSL_CA", ""),
  },
  store: {
    /** Default hosted OAuth-state store when no TIDB_HOST is set: a single SQLite
     *  file (node:sqlite, no server). Parent dir is created at boot. TiDB remains
     *  the optional scale path — set TIDB_HOST to select it. */
    sqlitePath: () => envString("CAPTATUM_SQLITE_PATH", "./data/captatum.sqlite"),
  },
};

function envString(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value : fallback;
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function envList(name: string): string[] {
  return envString(name, "").split(",").map((s) => s.trim()).filter(Boolean);
}

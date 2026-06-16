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
  },
  auth: {
    localHeaderMode: () => envString("LOCAL_HEADER_MODE", "false") === "true",
  },
  deployment: {
    flavor: () => envString("SMART_FETCH_FLAVOR", envString("DEPLOYMENT_FLAVOR", "local-binary")),
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
    ollamaBaseUrl: () => envString("OLLAMA_BASE_URL", ""),
    freeFirst: true,
  },
  render: {
    allowRenderDefault: false,
    timeoutMs: 20000,
  },
  tidb: {
    host: () => envString("TIDB_HOST", ""),
    port: () => envPositiveInteger("TIDB_PORT", 4000),
    database: () => envString("TIDB_DATABASE", "smartfetch"),
    user: () => envString("TIDB_USER", ""),
    password: () => envString("TIDB_PASSWORD", ""),
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

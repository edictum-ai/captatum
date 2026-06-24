import type { AuditLoggerPort, AuthAuditEvent, ToolAuditEvent } from "./application/ports/audit.ts";
import type { ClockPort } from "./application/ports/clock.ts";
import { loadAuthRuntimeConfig, type AuthRuntimeConfig } from "./application/use-cases/oauth-config.ts";
import { createSmartFetchUseCase } from "./application/use-cases/smart-fetch.ts";
import { config } from "./config.ts";
import { extractHtml } from "./infrastructure/extract/index.ts";
import { createWreqGuardedFetcher } from "./infrastructure/wreq/requester.ts";
import { createDefaultLlmTransformer } from "./infrastructure/llm/model-router.ts";
import { createRenderer } from "./infrastructure/render/index.ts";
import { createTidbStore } from "./infrastructure/tidb/index.ts";
import type { StorePort } from "./application/ports/store.ts";
import { assertHostedFlavor, createHttpApp } from "./interfaces/http/app.ts";

const clock: ClockPort = { nowMs: () => Date.now() };
const audit: AuditLoggerPort = {
  async writeAuthEvent(event: AuthAuditEvent): Promise<void> {
    console.log(JSON.stringify({ type: "audit.auth", ...event }));
  },
  async writeToolEvent(event: ToolAuditEvent): Promise<void> {
    console.log(JSON.stringify({ type: "audit.tool", ...event }));
  },
};
const runtime = loadAuthRuntimeConfig();
// This entrypoint opens a network listener. It is hosted-only: refuse to start
// it under the local-binary flavor (which has no OAuth boundary). Local mode is
// served over stdio (`node --no-warnings src/interfaces/mcp/stdio-bridge.ts`)
// and never opens a port.
assertHostedFlavor(runtime);
const host = config.http.host();
const port = config.http.port();
const security = mcpSecurity(runtime, host, port);
const store = await storeFor(runtime);
const smartFetch = createSmartFetchUseCase({
  fetcher: createWreqGuardedFetcher(),
  extractHtml,
  transformer: await createDefaultLlmTransformer(),
  renderer: createRenderer(),
  clock,
});
const app = await createHttpApp({
  smartFetch,
  runtime,
  clock,
  audit,
  store,
  ...security,
});

await app.listen({ host, port });
console.log(`captatum server listening on http://${host}:${port}`);

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

async function shutdown(): Promise<void> {
  await app.close();
  await store?.close();
}

async function storeFor(runtimeConfig: AuthRuntimeConfig): Promise<StorePort | undefined> {
  if (runtimeConfig.flavor !== "hosted") return undefined;
  const sslCa = config.tidb.sslCa();
  // SQLSTORE-1: TiDB Cloud requires TLS; OAuth token hashes + the DB password
  // must not cross the wire in plaintext. Fail-boot in production without it.
  if (process.env.NODE_ENV === "production" && !sslCa) {
    throw new Error("Hosted production requires TIDB_SSL_CA (TiDB TLS)");
  }
  return await createTidbStore({
    host: config.tidb.host(),
    port: config.tidb.port(),
    database: config.tidb.database(),
    user: config.tidb.user(),
    password: config.tidb.password(),
    waitForConnections: true,
    connectionLimit: 5,
    ...(sslCa ? { ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true, ca: sslCa } } : {}),
  });
}

function mcpSecurity(runtimeConfig: AuthRuntimeConfig, host: string, port: number) {
  const allowedHosts = config.mcp.allowedHosts();
  const allowedOrigins = config.mcp.allowedOrigins();
  if (runtimeConfig.flavor === "hosted" && (!allowedHosts.length || !allowedOrigins.length)) {
    throw new Error("Hosted MCP requires MCP_ALLOWED_HOSTS and MCP_ALLOWED_ORIGINS");
  }
  return {
    allowedHosts: allowedHosts.length ? allowedHosts : localHosts(host, port),
    allowedOrigins,
  };
}

function localHosts(host: string, port: number): string[] {
  return [...new Set([host, `${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`])];
}

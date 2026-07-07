import type { AuditLoggerPort, AuthAuditEvent, ToolAuditEvent } from "./application/ports/audit.ts";
import type { ClockPort } from "./application/ports/clock.ts";
import { loadAuthRuntimeConfig, type AuthRuntimeConfig } from "./application/use-cases/oauth-config.ts";
import { createCaptatumUseCase } from "./application/use-cases/captatum.ts";
import { createCaptatumBulkUseCase } from "./application/use-cases/captatum-bulk.ts";
import { createAdapterRegistry } from "./application/adapters.ts";
import { config } from "./config.ts";
import { extractHtml } from "./infrastructure/extract/index.ts";
import { createWreqGuardedFetcher } from "./infrastructure/wreq/requester.ts";
import { LimitingFetcher } from "./infrastructure/http/limiting-fetcher.ts";
import { InMemoryBulkQuotaPort } from "./application/use-cases/in-memory-bulk-quota.ts";
import { createDefaultLlmTransformer } from "./infrastructure/llm/model-router.ts";
import { createRenderer } from "./infrastructure/render/index.ts";
import { createHostedStore } from "./infrastructure/store-selection.ts";
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
// SQLSTORE-2: periodic expiry sweep — delete expired auth codes / refresh
// tokens / orphaned revoked families every 5 minutes. unref so it doesn't
// keep the process alive; catch so sweep failures never crash the server.
if (store) {
  setInterval(() => {
    store.sweepExpired(new Date().toISOString()).catch((e) =>
      process.stderr.write(`captatum: store sweep failed: ${e instanceof Error ? e.message : e}\n`),
    );
  }, 5 * 60 * 1000).unref();
}
// BULK-2: wrap the hosted FetcherPort in a LimitingFetcher — a process-wide global
// fetch-concurrency cap shared across ALL callers (single-fetch + bulk seeds + Tier-3
// render subresources). Bounds the 8 bulks × maxConcurrency worst case below the box sizing;
// single-fetch shares the FIFO pool (may briefly queue under heavy bulk load — graceful timeout).
// (server.ts is hosted-only; the local binary keeps the raw fetcher — single-user.)
const fetcher = new LimitingFetcher(createWreqGuardedFetcher(), config.bulk.globalFetchConcurrency());
const captatum = createCaptatumUseCase({
  fetcher,
  extractHtml,
  transformer: await createDefaultLlmTransformer(),
  renderer: createRenderer(),
  clock,
});
// captatum_bulk: hosted ships ON (CAPTATUM_BULK_ENABLED default true as of PR 3 — the
// LimitingFetcher (BULK-2) + BulkQuotaPort (BULK-1) gate has landed). Built with the UNWRAPPED
// captatum executor so the route's one-slot admission wrap bounds the whole call, not per-seed
// fan-out. The per-tenant quota (BULK-1) bounds cross-call amplification, fail-closed.
const bulk = config.bulk.enabled()
  ? createCaptatumBulkUseCase({
    executor: captatum,
    adapters: createAdapterRegistry(),
    clock,
    operator: {
      maxPerHostInflight: config.bulk.maxPerHostInflight(),
      crawlDelayMs: config.bulk.crawlDelayMs(),
      maxConcurrency: config.bulk.maxConcurrency(),
    },
    quota: new InMemoryBulkQuotaPort({
      clock,
      windowSeconds: config.bulk.quotaWindowSeconds(),
      limit: config.bulk.quotaSeedLimit(),
    }),
  })
  : undefined;
const app = await createHttpApp({
  captatum,
  ...(bulk !== undefined ? { bulk } : {}),
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
  // DEFAULT backend is SQLite (a single file, no server) so a hosted deploy needs
  // no database — one-click deploys work with zero external state. Set TIDB_HOST
  // to opt into the TiDB scale path (TLS still required, SQLSTORE-1). The choice
  // and TLS gate live in store-selection.ts.
  const { store, backend } = await createHostedStore({
    tidb: {
      host: config.tidb.host(),
      port: config.tidb.port(),
      database: config.tidb.database(),
      user: config.tidb.user(),
      password: config.tidb.password(),
      sslCa: config.tidb.sslCa(),
    },
    sqlitePath: config.store.sqlitePath(),
  });
  console.log(`captatum OAuth-state store: ${backend}`);
  return store;
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

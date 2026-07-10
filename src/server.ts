import { Bridge, RequestAuthorizer } from "mcp-sso";
import { createCloudflareAccessIdentity } from "mcp-sso/identity/cloudflare-access";
import type { AuditLoggerPort, AuthAuditEvent, ToolAuditEvent } from "./application/ports/audit.ts";
import type { ClockPort } from "./application/ports/clock.ts";
import { loadCaptatumAuth } from "./application/mcp-sso-config.ts";
import { createCaptatumUseCase } from "./application/use-cases/captatum.ts";
import { createCaptatumBulkUseCase } from "./application/use-cases/captatum-bulk.ts";
import { createAdapterRegistry } from "./application/adapters.ts";
import { config } from "./config.ts";
import { extractHtml } from "./infrastructure/extract/index.ts";
import { createWreqGuardedFetcher } from "./infrastructure/wreq/requester.ts";
import { LimitingFetcher } from "./infrastructure/http/limiting-fetcher.ts";
import { createHostedAuthStore } from "./infrastructure/auth-store.ts";
import { InMemoryBulkQuotaPort } from "./application/use-cases/in-memory-bulk-quota.ts";
import { createDefaultLlmTransformer } from "./infrastructure/llm/model-router.ts";
import { createRenderer } from "./infrastructure/render/index.ts";
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
const auth = loadCaptatumAuth();
// This entrypoint opens a network listener. It is hosted-only: refuse to start
// it under the local-binary flavor (which has no OAuth boundary). Local mode is
// served over stdio (`node --no-warnings src/interfaces/mcp/stdio-bridge.ts`)
// and never opens a port.
assertHostedFlavor(auth.flavor);
if (!auth.config) throw new Error("hosted flavor requires a BridgeConfig (loadCaptatumAuth)");
const oauthConfig = auth.config;
const host = config.http.host();
const port = config.http.port();
const security = mcpSecurity(auth.flavor, host, port);
const { store, backend } = await createHostedAuthStore();
console.log(`captatum OAuth-state store: ${backend}`);
// SQLSTORE-2: periodic expiry sweep — delete expired auth codes / refresh
// tokens / orphaned revoked families every 5 minutes. unref so it doesn't
// keep the process alive; catch so sweep failures never crash the server.
setInterval(() => {
  store
    .sweepExpired(new Date().toISOString())
    .catch((e) =>
      process.stderr.write(`captatum: store sweep failed: ${e instanceof Error ? e.message : e}\n`),
    );
}, 5 * 60 * 1000).unref();
// The mcp-sso Bridge owns the OAuth flow (DCR/PKCE/consent/token/revoke + metadata);
// the RequestAuthorizer verifies `/mcp` bearer tokens; the CF-Access identity resolves
// the `/oauth/authorize` subject. All share the same clock + audit + store + config.
const bridge = new Bridge({ config: oauthConfig, store, clock, audit });
const authorizer = new RequestAuthorizer({ config: oauthConfig, clock, audit });
const identity = createCloudflareAccessIdentity({
  audience: config.cloudflareAccess.audience(),
  certsUrl: config.cloudflareAccess.certsUrl(),
  issuer: config.cloudflareAccess.issuer(),
  emailAllowlist: config.cloudflareAccess.emailAllowlist(),
});
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
  flavor: auth.flavor,
  bridge,
  authorizer,
  identity,
  clock,
  audit,
  ...security,
});

await app.listen({ host, port });
console.log(`captatum server listening on http://${host}:${port}`);

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

async function shutdown(): Promise<void> {
  await app.close();
  await store.close();
}

function mcpSecurity(flavor: "hosted" | "local-binary", host: string, port: number) {
  const allowedHosts = config.mcp.allowedHosts();
  const allowedOrigins = config.mcp.allowedOrigins();
  if (flavor === "hosted" && (!allowedHosts.length || !allowedOrigins.length)) {
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

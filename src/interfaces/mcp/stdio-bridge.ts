import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  AuditLoggerPort,
  AuthAuditEvent,
  ToolAuditEvent,
} from "../../application/ports/audit.ts";
import type { ClockPort } from "../../application/ports/clock.ts";
import { extractHtml } from "../../infrastructure/extract/index.ts";
import { createDefaultLlmTransformer } from "../../infrastructure/llm/model-router.ts";
import { PlaywrightRenderer } from "../../infrastructure/render/index.ts";
import { createWreqGuardedFetcher } from "../../infrastructure/wreq/requester.ts";
import { createLocalMcpServer, type LocalMcpDeps } from "./local-server.ts";

/**
 * Self-contained local-binary entrypoint: serves the same `smart_fetch` engine
 * over a stdio MCP transport. No OAuth, no HTTP listener, single-user/single-agent.
 * stdout is reserved for JSON-RPC framing, so every log line goes to stderr.
 */

const clock: ClockPort = { nowMs: () => Date.now() };

const audit: AuditLoggerPort = {
  async writeAuthEvent(event: AuthAuditEvent): Promise<void> {
    logStderr({ type: "audit.auth", ...event });
  },
  async writeToolEvent(event: ToolAuditEvent): Promise<void> {
    logStderr({ type: "audit.tool", ...event });
  },
};

function logStderr(record: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

async function buildLocalDeps(): Promise<LocalMcpDeps> {
  return {
    fetcher: createWreqGuardedFetcher(),
    extractHtml,
    transformer: await createDefaultLlmTransformer(),
    renderer: new PlaywrightRenderer(),
    clock,
    audit,
  };
}

async function startStdioBridge(): Promise<Server> {
  const server = await createLocalMcpServer(await buildLocalDeps());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    "smart-fetch local stdio bridge ready: single-user, no OAuth, no network listener.\n",
  );
  const close = (): void => void server.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return server;
}

startStdioBridge().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`captatum stdio bridge failed to start: ${message}\n`);
  process.exitCode = 1;
});

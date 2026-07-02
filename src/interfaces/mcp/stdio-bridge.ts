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
import { createRenderer } from "../../infrastructure/render/index.ts";
import { createWreqGuardedFetcher } from "../../infrastructure/wreq/requester.ts";
import { createLocalMcpServer, type LocalMcpDeps } from "./local-server.ts";

/**
 * Self-contained local-binary entrypoint: serves the same `captatum` engine
 * over a stdio MCP transport. No OAuth, no HTTP listener, single-user/single-agent.
 *
 * stdout is the JSON-RPC channel. stderr MUST stay silent on a healthy boot — some
 * MCP clients (e.g. Claude Code) treat any stderr during the initialize handshake as
 * a fatal server error (-32000) and refuse to connect. So audit/ready output is gated
 * behind CAPTATUM_STDIO_DEBUG=1 (set it to see audit events + the ready line on stderr).
 * A genuine boot failure is still written to stderr (the server is dying anyway).
 */
const debug = process.env.CAPTATUM_STDIO_DEBUG === "1";

const clock: ClockPort = { nowMs: () => Date.now() };

const audit: AuditLoggerPort = {
  async writeAuthEvent(event: AuthAuditEvent): Promise<void> {
    if (debug) logStderr({ type: "audit.auth", ...event });
  },
  async writeToolEvent(event: ToolAuditEvent): Promise<void> {
    if (debug) logStderr({ type: "audit.tool", ...event });
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
    renderer: createRenderer(),
    clock,
    audit,
  };
}

async function startStdioBridge(): Promise<Server> {
  const server = await createLocalMcpServer(await buildLocalDeps());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (debug) {
    process.stderr.write(
      "captatum local stdio bridge ready: single-user, no OAuth, no network listener.\n",
    );
  }
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

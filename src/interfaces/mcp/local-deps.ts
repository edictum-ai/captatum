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
import type { LocalMcpDeps } from "./local-server.ts";

/**
 * Shared local-binary dependencies (fetcher + extractor + transformer + renderer
 * + clock + audit) for both the stdio MCP bridge and the one-shot CLI. Extracted
 * so importing it does NOT start the stdio server (stdio-bridge.ts auto-starts on
 * import; this module is side-effect-free).
 *
 * The audit sink is stderr-silent unless CAPTATUM_STDIO_DEBUG=1 (Claude Code
 * rejects stderr during the MCP handshake; the CLI is one-shot so stderr is fine,
 * but staying silent-by-default keeps behavior uniform + the debug opt-in useful).
 */
const debug = process.env.CAPTATUM_STDIO_DEBUG === "1";

export const localClock: ClockPort = { nowMs: () => Date.now() };

export const localAudit: AuditLoggerPort = {
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

export async function buildLocalDeps(): Promise<LocalMcpDeps> {
  return {
    fetcher: createWreqGuardedFetcher(),
    extractHtml,
    transformer: await createDefaultLlmTransformer(),
    renderer: createRenderer(),
    clock: localClock,
    audit: localAudit,
  };
}

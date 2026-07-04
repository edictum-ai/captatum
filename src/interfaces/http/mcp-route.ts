import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuditLoggerPort } from "../../application/ports/audit.ts";
import type { ClockPort } from "../../application/ports/clock.ts";
import type { RequestAuthorizer } from "../../application/use-cases/request-auth.ts";
import type { CaptatumUseCase } from "../../application/use-cases/captatum.ts";
import { config } from "../../config.ts";
import { createCaptatumMcpServer, OverloadedError } from "../mcp/server.ts";
import { sendMcpAuthError } from "./errors.ts";

export interface McpRouteDeps {
  captatum: Pick<CaptatumUseCase, "execute" | "defaultOutput">;
  authorizer: Pick<RequestAuthorizer, "authorize">;
  audit: AuditLoggerPort;
  clock: ClockPort;
  hosted: boolean;
  allowedHosts: string[];
  allowedOrigins: string[];
}

export async function registerMcpRoute(app: FastifyInstance, deps: McpRouteDeps): Promise<void> {
  assertMcpSecurity(deps);
  app.post(config.mcp.endpointPath, async (request, reply) => handleMcpPost(request, reply, deps));
  app.get(config.mcp.endpointPath, methodNotAllowed);
  app.delete(config.mcp.endpointPath, methodNotAllowed);
}

/**
 * Process-wide admission limiter bounding concurrent captatum EXECUTIONS
 * (DOS-2). Sized for the hosted task (2 vCPU / 4 GiB): each in-flight
 * fetch/render/transform holds a socket + bounded memory, so 8 concurrent keeps
 * headroom without letting one tenant starve the rest. Over-cap calls throw
 * OverloadedError (see withAdmission) → a distinct RETRYABLE JSON-RPC error the
 * client backs off and retries (NOT a generic InternalError). (#84)
 */
const MAX_CONCURRENT_MCP = 8;

export class AdmissionLimiter {
  private active = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }
  tryAcquire(): boolean {
    if (this.active >= this.capacity) return false;
    this.active += 1;
    return true;
  }
  release(): void {
    if (this.active > 0) this.active -= 1;
  }
}

const mcpAdmission = new AdmissionLimiter(MAX_CONCURRENT_MCP);

async function handleMcpPost(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: McpRouteDeps,
): Promise<void> {
  let auth;
  try {
    auth = await deps.authorizer.authorize({ authorization: request.headers.authorization });
  } catch (error) {
    sendMcpAuthError(reply, error);
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: deps.allowedHosts,
    allowedOrigins: deps.allowedOrigins,
  });
  // DOS-2: cap concurrent captatum EXECUTIONS (not POSTs) — a JSON-RPC batch
  // is one POST but dispatches many tools/call, so the limiter must wrap each
  // execute. An over-cap call throws OverloadedError, surfaced to the client as
  // a distinct RETRYABLE JSON-RPC error (data.retryable) the CLIENT backs off
  // and retries — not the generic InternalError it used to collapse to. (#84)
  const mcp = createCaptatumMcpServer({
    captatum: withAdmission(deps.captatum, mcpAdmission),
    auth,
    audit: deps.audit,
    clock: deps.clock,
  });
  await mcp.connect(transport);
  reply.hijack();
  try {
    await transport.handleRequest(request.raw, reply.raw, request.body);
  } catch {
    sendRawInternalError(reply);
  } finally {
    await mcp.close();
  }
}

/** Wraps a CaptatumUseCase so each `execute()` acquires/releases an admission slot. */
export function withAdmission(
  inner: Pick<CaptatumUseCase, "execute" | "defaultOutput">,
  limiter: AdmissionLimiter,
): Pick<CaptatumUseCase, "execute" | "defaultOutput"> {
  return {
    execute: async (...args: Parameters<CaptatumUseCase["execute"]>) => {
      if (!limiter.tryAcquire()) {
        throw new OverloadedError("captatum: server overloaded — too many concurrent captatum calls");
      }
      try {
        return await inner.execute(...args);
      } finally {
        limiter.release();
      }
    },
    defaultOutput: inner.defaultOutput,
  };
}

function assertMcpSecurity(deps: McpRouteDeps): void {
  if (!deps.hosted) return;
  if (deps.allowedHosts.length === 0 || deps.allowedOrigins.length === 0) {
    throw new Error("Hosted MCP requires explicit allowed hosts and origins");
  }
}

function methodNotAllowed(_request: FastifyRequest, reply: FastifyReply): void {
  reply.header("allow", "POST").code(405).send({
    error: { code: "method_not_allowed", message: "Use POST /mcp" },
  });
}

function sendRawInternalError(reply: FastifyReply): void {
  if (reply.raw.headersSent) {
    reply.raw.end();
    return;
  }
  reply.raw.writeHead(500, { "content-type": "application/json" });
  reply.raw.end(JSON.stringify({ error: { code: "internal_error", message: "MCP request failed" } }));
}

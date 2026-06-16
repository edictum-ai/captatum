import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuditLoggerPort } from "../../application/ports/audit.ts";
import type { ClockPort } from "../../application/ports/clock.ts";
import type { RequestAuthorizer } from "../../application/use-cases/request-auth.ts";
import type { SmartFetchUseCase } from "../../application/use-cases/smart-fetch.ts";
import { config } from "../../config.ts";
import { createSmartFetchMcpServer } from "../mcp/server.ts";
import { sendMcpAuthError } from "./errors.ts";

export interface McpRouteDeps {
  smartFetch: Pick<SmartFetchUseCase, "execute">;
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
  const mcp = createSmartFetchMcpServer({ smartFetch: deps.smartFetch, auth, audit: deps.audit, clock: deps.clock });
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

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuditLoggerPort } from "../../application/ports/audit.ts";
import type { ClockPort } from "../../application/ports/clock.ts";
import { OAuthError } from "../../application/use-cases/oauth-errors.ts";
import { requireScope, requiredScopeForSmartFetch } from "../../application/use-cases/oauth-scopes.ts";
import type { RequestAuthResult } from "../../application/use-cases/request-auth.ts";
import type { SmartFetchUseCase } from "../../application/use-cases/smart-fetch.ts";
import {
  normalizeSmartFetchInput,
  SmartFetchInputError,
} from "../../application/use-cases/smart-fetch-input.ts";
import type { Result } from "../../domain/result.ts";
import { resultToMcpText } from "./format.ts";
import { SMART_FETCH_TOOL_NAME, smartFetchToolDefinition } from "./schema.ts";

const AUTH_JSONRPC_CODE = -32001;

export interface SmartFetchMcpServerDeps {
  smartFetch: Pick<SmartFetchUseCase, "execute">;
  auth: RequestAuthResult;
  audit: AuditLoggerPort;
  clock: ClockPort;
}

export function createSmartFetchMcpServer(deps: SmartFetchMcpServerDeps): Server {
  const server = new Server({ name: "smart-fetch", version: "0.1.0" }, {
    capabilities: { tools: { listChanged: false } },
  });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [smartFetchToolDefinition],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    if (request.params.name !== SMART_FETCH_TOOL_NAME) {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
    }
    return await callSmartFetch(request.params.arguments, deps);
  });

  return server;
}

async function callSmartFetch(args: unknown, deps: SmartFetchMcpServerDeps): Promise<CallToolResult> {
  const started = deps.clock.nowMs();
  try {
    normalizeSmartFetchInput(args);
    requireScope(deps.auth, requiredScopeForSmartFetch(args));
    const result = await deps.smartFetch.execute(args, { fetchedAt: new Date(deps.clock.nowMs()).toISOString() });
    await auditResult(deps, result);
    return {
      content: [{ type: "text", text: resultToMcpText(result) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (error) {
    await auditFailure(deps, args, started, error);
    throw toMcpError(error);
  }
}

function toMcpError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  if (error instanceof OAuthError) {
    return new McpError(AUTH_JSONRPC_CODE, `${error.code}: ${error.message}`);
  }
  if (error instanceof SmartFetchInputError) {
    const { code, message } = error.body.error;
    return new McpError(ErrorCode.InvalidParams, `${code}: ${message}`);
  }
  return new McpError(ErrorCode.InternalError, "smart_fetch failed");
}

async function auditResult(deps: SmartFetchMcpServerDeps, result: Result): Promise<void> {
  await deps.audit.writeToolEvent({
    occurredAt: new Date(deps.clock.nowMs()).toISOString(),
    subject: deps.auth.subject,
    clientId: deps.auth.clientId,
    tool: SMART_FETCH_TOOL_NAME,
    url_host: urlHost(result.finalUrl),
    tier: result.tier,
    platform: result.platform.adapterId,
    output: result.output,
    status: result.code,
    bytes: result.bytes,
    durationMs: result.durationMs,
    transformProvider: result.transform?.provider,
    transformModel: result.transform?.model,
  });
}

async function auditFailure(
  deps: SmartFetchMcpServerDeps,
  args: unknown,
  started: number,
  error: unknown,
): Promise<void> {
  await deps.audit.writeToolEvent({
    occurredAt: new Date(deps.clock.nowMs()).toISOString(),
    subject: deps.auth.subject,
    clientId: deps.auth.clientId,
    tool: SMART_FETCH_TOOL_NAME,
    url_host: inputUrlHost(args),
    tier: "error",
    output: inputOutput(args),
    status: error instanceof OAuthError ? error.status : 0,
    bytes: 0,
    durationMs: Math.max(0, Math.round(deps.clock.nowMs() - started)),
  });
}

function inputUrlHost(args: unknown): string | undefined {
  if (!isRecord(args) || typeof args.url !== "string") return undefined;
  return urlHost(args.url);
}

function inputOutput(args: unknown): string | undefined {
  if (!isRecord(args) || typeof args.output !== "string") return undefined;
  return args.output;
}

function urlHost(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

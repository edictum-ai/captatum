import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import type { JWK } from "jose";
import type { AuthAuditEvent, AuditLoggerPort, ToolAuditEvent } from "../src/application/ports/audit.ts";
import type { ClockPort } from "../src/application/ports/clock.ts";
import type { FetcherOptions, FetcherPort, FetcherResult, RejectResult } from "../src/application/ports/fetcher.ts";
import type { StorePort } from "../src/application/ports/store.ts";
import type { TransformInput, TransformPort, TransformResult } from "../src/application/ports/transformer.ts";
import type { AuthRuntimeConfig, HostedOAuthConfig } from "../src/application/use-cases/oauth-config.ts";
import { signAccessToken } from "../src/application/use-cases/oauth-crypto.ts";
import { createSmartFetchUseCase } from "../src/application/use-cases/smart-fetch.ts";
import { config } from "../src/config.ts";
import { extractHtml } from "../src/infrastructure/extract/index.ts";
import { assertHostedFlavor, createHttpApp, HostedFlavorError } from "../src/interfaces/http/app.ts";

const NOW_MS = Date.parse("2026-06-16T12:00:00.000Z");
const HOST = "smart-fetch.test";
const ORIGIN = "https://client.test";

test("HTTP MCP listener refuses local-binary instead of exposing an unauthenticated /mcp", async () => {
  assert.throws(
    () => assertHostedFlavor({ flavor: "local-binary" } as AuthRuntimeConfig),
    (error: unknown) => error instanceof HostedFlavorError && error.code === "hosted_flavor_required",
  );
  await assert.rejects(
    createHttpApp({
      smartFetch: createSmartFetchUseCase({
        fetcher: new FakeFetcher("<main>Body</main>"),
        extractHtml,
        clock: new FakeClock(NOW_MS),
      }),
      runtime: { flavor: "local-binary" } as AuthRuntimeConfig,
      clock: new FakeClock(NOW_MS),
      audit: new MemoryAudit(),
      allowedHosts: [HOST],
      allowedOrigins: [ORIGIN],
    }),
    (error: unknown) => error instanceof HostedFlavorError,
  );
});

test("POST /mcp rejects unauthenticated hosted calls before smart_fetch runs", async () => {
  const ctx = await setup();
  const response = await ctx.rpc({ arguments: { url: "https://fixture.test/", output: "raw" } }, undefined);

  assert.equal(response.statusCode, 401);
  assert.match(String(response.headers["www-authenticate"]), /Bearer/);
  assert.deepEqual(response.json(), {
    jsonrpc: "2.0",
    error: { code: -32001, message: "invalid_token: Bearer token is required" },
    id: null,
  });
  assert.equal(ctx.fetcher.calls.length, 0);
  await ctx.app.close();
});

test("authenticated fetch:read call can perform output raw", async () => {
  const ctx = await setup();
  const response = await ctx.rpc({ arguments: { url: "https://fixture.test/path?x=1", output: "raw" } }, ["fetch:read"]);

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["mcp-session-id"], undefined);
  const body = response.json() as RpcSuccess;
  assert.equal(body.result.structuredContent.output, "raw");
  assert.equal(body.result.structuredContent.result, "Fixture raw body");
  assert.match(body.result.content[0]?.text ?? "", /^<!-- captatum /);
  assert.equal(ctx.fetcher.calls.length, 1);
  assert.equal(ctx.audit.toolEvents.at(-1)?.url_host, "https://fixture.test");
  await ctx.app.close();
});

test("authenticated call without fetch:transform cannot perform summary output", async () => {
  const transformer = new FakeTransformer();
  const ctx = await setup({ transformer });
  const response = await ctx.rpc({ arguments: { url: "https://fixture.test/", output: "summary" } }, ["fetch:read"]);

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as RpcError;
  assert.equal(body.error.code, -32001);
  assert.match(body.error.message, /insufficient_scope/);
  assert.equal(ctx.fetcher.calls.length, 0);
  assert.equal(transformer.calls.length, 0);
  assert.equal(ctx.audit.toolEvents.at(-1)?.status, 403);
  await ctx.app.close();
});

test("invalid tool input returns validation error before outbound fetch", async () => {
  const ctx = await setup();
  const response = await ctx.rpc({ arguments: { url: "https://fixture.test/", output: "raw", extra: true } }, ["fetch:read"]);

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as RpcError;
  assert.equal(body.error.code, -32602);
  assert.match(body.error.message, /invalid_input/);
  assert.equal(ctx.fetcher.calls.length, 0);
  assert.equal(ctx.audit.toolEvents.at(-1)?.status, 0);
  await ctx.app.close();
});

test("tools/list advertises a strict smart_fetch input schema", async () => {
  const ctx = await setup();
  const response = await ctx.rpc({ method: "tools/list", params: {} }, ["fetch:read"]);

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as ToolsListSuccess;
  const tool = body.result.tools.find((item) => item.name === "smart_fetch");
  assert.ok(tool);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.ok(tool.description.includes("Default output is summary"));
  assert.ok(tool.description.includes("raw clean content is available"));
  await ctx.app.close();
});


test("GET and DELETE /mcp are method-not-allowed", async () => {
  const ctx = await setup();
  for (const method of ["GET", "DELETE"] as const) {
    const response = await ctx.app.inject({ method, url: config.mcp.endpointPath, headers: { host: HOST } });
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.allow, "POST");
  }
  await ctx.app.close();
});

test("MCP transport rejects authenticated requests with a disallowed origin", async () => {
  const ctx = await setup();
  const response = await ctx.rpc(
    { arguments: { url: "https://fixture.test/", output: "raw" } },
    ["fetch:read"],
    { origin: "https://evil.test" },
  );

  assert.equal(response.statusCode, 403);
  assert.match(response.body, /Invalid Origin header/);
  assert.equal(ctx.fetcher.calls.length, 0);
  await ctx.app.close();
});

async function setup(options: { transformer?: TransformPort } = {}) {
  const clock = new FakeClock(NOW_MS);
  const oauth = hostedConfig();
  const fetcher = new FakeFetcher("<main>Fixture raw body</main>");
  const audit = new MemoryAudit();
  const app = await createHttpApp({
    smartFetch: createSmartFetchUseCase({ fetcher, extractHtml, transformer: options.transformer, clock }),
    runtime: { flavor: "hosted", oauth },
    clock,
    audit,
    store: new MemoryStore(),
    allowedHosts: [HOST],
    allowedOrigins: [ORIGIN],
  });
  return {
    app,
    fetcher,
    audit,
    rpc: async (input: RpcInput, scopes?: Array<"fetch:read" | "fetch:transform">, headers: Record<string, string> = {}) => {
      const token = scopes ? await signAccessToken({ subject: "user-1", clientId: "client-1", scopes }, oauth, clock) : undefined;
      return await app.inject({
        method: "POST",
        url: config.mcp.endpointPath,
        headers: {
          host: HOST,
          origin: ORIGIN,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": config.mcp.stableProtocolVersion,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        payload: rpcPayload(input),
      });
    },
  };
}

function rpcPayload(input: RpcInput): Record<string, unknown> {
  if (input.method === "tools/list") return { jsonrpc: "2.0", id: 1, method: "tools/list", params: input.params };
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "smart_fetch", arguments: input.arguments },
  };
}

class FakeClock implements ClockPort {
  private readonly ms: number;
  constructor(ms: number) { this.ms = ms; }
  nowMs(): number { return this.ms; }
}

class FakeFetcher implements FetcherPort {
  readonly calls: Array<{ url: string; opts: FetcherOptions }> = [];
  private readonly html: string;
  constructor(html: string) { this.html = html; }
  async fetchGuarded(url: string, opts: FetcherOptions): Promise<FetcherResult | RejectResult> {
    this.calls.push({ url, opts });
    const bytes = new TextEncoder().encode(this.html);
    return {
      status: 200,
      finalUrl: url,
      redirects: [],
      bodyStream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      contentType: "text/html; charset=utf-8",
      bytes: bytes.byteLength,
    };
  }
}

class FakeTransformer implements TransformPort {
  readonly calls: TransformInput[] = [];
  async transform(input: TransformInput): Promise<TransformResult> {
    this.calls.push(input);
    return { result: "summary", info: { provider: "openrouter", model: "model" } };
  }
}

class MemoryAudit implements AuditLoggerPort {
  readonly authEvents: AuthAuditEvent[] = [];
  readonly toolEvents: ToolAuditEvent[] = [];
  async writeAuthEvent(event: AuthAuditEvent): Promise<void> { this.authEvents.push(event); }
  async writeToolEvent(event: ToolAuditEvent): Promise<void> { this.toolEvents.push(event); }
}

class MemoryStore implements StorePort {
  async saveAuthCode(): Promise<void> {}
  async consumeAuthCode(): Promise<null> { return null; }
  async saveRefreshToken(): Promise<void> {}
  async rotateRefreshToken(): Promise<null> { return null; }
  async revokeRefreshTokenFamily(): Promise<void> {}
  async close(): Promise<void> {}
}

function hostedConfig(): HostedOAuthConfig {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    issuer: "https://smart-fetch.test",
    resource: "https://smart-fetch.test/mcp",
    consentSigningSecret: "test-consent-secret-with-enough-entropy",
    signingPrivateJwk: { ...privateKey.export({ format: "jwk" }), alg: "ES256", kid: "test-key-1" } as JWK,
    signingKeyId: "test-key-1",
    redirectAllowlist: ["https://client.test/callback"],
    accessTokenTtlSeconds: 600,
    refreshTokenTtlSeconds: 2_592_000,
    consentTokenTtlSeconds: 300,
    authorizationCodeTtlSeconds: 300,
  };
}

type RpcInput = { method?: "tools/call"; arguments: unknown } | { method: "tools/list"; params: Record<string, unknown> };
interface RpcSuccess { result: { content: Array<{ text?: string }>; structuredContent: { output: string; result: string } } }
interface RpcError { error: { code: number; message: string } }
interface ToolsListSuccess { result: { tools: Array<{ name: string; description: string; inputSchema: { additionalProperties?: boolean } }> } }

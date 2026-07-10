import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuditLoggerPort } from "../src/application/ports/audit.ts";
import type { ClockPort } from "../src/application/ports/clock.ts";
import type {
  FetcherOptions,
  FetcherPort,
  FetcherResult,
  RejectResult,
} from "../src/application/ports/fetcher.ts";
import type { TransformInput, TransformPort, TransformResult } from "../src/application/ports/transformer.ts";
import type { CaptatumAuthRuntime } from "../src/application/mcp-sso-config.ts";
import { extractHtml } from "../src/infrastructure/extract/index.ts";
import {
  assertLocalFlavor,
  createLocalMcpServer,
  LocalFlavorError,
  type LocalMcpDeps,
} from "../src/interfaces/mcp/local-server.ts";
import { captatumToolDefinition } from "../src/interfaces/mcp/schema.ts";

const NOW_MS = Date.parse("2026-06-16T12:00:00.000Z");

test("local bridge exposes captatum with the same schema as hosted MCP", async () => {
  const ctx = await connect({ fetcher: new FakeFetcher("<main>Body</main>") });
  const tools = await ctx.client.listTools();
  const tool = tools.tools.find((entry) => entry.name === "captatum");

  assert.ok(tool);
  assert.equal(tool.description, captatumToolDefinition.description);
  assert.deepEqual(tool.inputSchema, captatumToolDefinition.inputSchema);
  assert.equal(tool.inputSchema.additionalProperties, false);
  await ctx.close();
});

test("local mode starts without OAuth secrets and returns a contract-shaped raw result", async () => {
  const restore = stripAuthEnv();
  try {
    // No `runtime` override: resolves via process env, which defaults to local-binary.
    const ctx = await connect({ fetcher: new FakeFetcher("<main>Local body</main>"), runtime: undefined });
    const call = await ctx.client.callTool({
      name: "captatum",
      arguments: { url: "https://fixture.test/page", output: "raw" },
    });
    const result = call.structuredContent as Record<string, unknown>;

    assert.equal(result.schemaVersion, 1);
    assert.equal(result.output, "raw");
    assert.equal(result.code, 200);
    assert.equal((result.platform as { adapterId?: string }).adapterId, "generic");
    assert.match(firstText(call), /^<!-- captatum /);
    await ctx.close();
  } finally {
    restore();
  }
});

test("local mode refuses the hosted flavor instead of exposing a network listener", async () => {
  assert.throws(
    () => assertLocalFlavor({ flavor: "hosted" }),
    (error: unknown) => error instanceof LocalFlavorError && error.code === "local_flavor_required",
  );
  await assert.rejects(
    createLocalMcpServer({
      fetcher: new FakeFetcher("<main>Body</main>"),
      extractHtml,
      clock: fixedClock(),
      audit: new NoopAudit(),
      runtime: { flavor: "hosted" },
    }),
    (error: unknown) => error instanceof LocalFlavorError,
  );
});

test("local mode blocks guarded-fetch failures the same way hosted mode does", async () => {
  const ctx = await connect({ fetcher: new RejectingFetcher("private_address", "blocked private address") });
  const call = await ctx.client.callTool({
    name: "captatum",
    arguments: { url: "https://blocked.test/", output: "raw" },
  });
  const result = call.structuredContent as Record<string, unknown>;

  assert.equal(result.code, 0);
  assert.equal(result.codeText, "FETCH_REJECTED");
  assert.equal(result.tier, "error");
  assert.equal(result.resolvedVia, "guarded-fetch");
  assert.deepEqual(result.errors, [{ code: "private_address", message: "blocked private address" }]);
  await ctx.close();
});

test("local mode runs the transform default with no token, matching hosted semantics", async () => {
  const transformer = new FakeTransformer();
  const ctx = await connect({ fetcher: new FakeFetcher("<main>Body</main>"), transformer });
  const call = await ctx.client.callTool({
    name: "captatum",
    arguments: { url: "https://fixture.test/", output: "summary", prompt: "what is this" },
  });
  const result = call.structuredContent as Record<string, unknown>;

  assert.equal(transformer.calls.length, 1);
  assert.equal(result.output, "summary");
  assert.equal(result.result, "summary text");
  assert.equal((result.transform as { provider?: string }).provider, "openrouter");
  await ctx.close();
});

test("debug flag gates heavy diagnostic fields through the real MCP server", async () => {
  // HTML carries structured data so `structured` is present and debug-gating is observable.
  const richHtml = `<html><head><title>T</title><meta property="og:title" content="Debug Fixture"></head><main>Body</main></html>`;
  const ctx = await connect({ fetcher: new FakeFetcher(richHtml) });

  const lean = await ctx.client.callTool({
    name: "captatum",
    arguments: { url: "https://fixture.test/", output: "raw" },
  });
  const leanShape = lean.structuredContent as Record<string, unknown>;
  assert.equal("timings" in leanShape, false, "timings leaked into default payload");
  assert.equal("structured" in leanShape, false, "structured leaked into default payload");
  assert.equal("attempts" in leanShape, false, "attempts leaked into default payload");

  const debug = await ctx.client.callTool({
    name: "captatum",
    arguments: { url: "https://fixture.test/", output: "raw", debug: true },
  });
  const debugShape = debug.structuredContent as Record<string, unknown>;
  assert.ok(Array.isArray(debugShape.attempts), "debug: true must expose attempts");
  assert.ok(typeof debugShape.timings === "object", "debug: true must expose timings");
  assert.ok(typeof debugShape.structured === "object", "debug: true must expose structured");

  await ctx.close();
});

interface ConnectOptions {
  fetcher: FetcherPort;
  transformer?: TransformPort;
  runtime?: CaptatumAuthRuntime;
}

async function connect(options: ConnectOptions) {
  const deps: LocalMcpDeps = {
    fetcher: options.fetcher,
    extractHtml,
    clock: fixedClock(),
    audit: new NoopAudit(),
    transformer: options.transformer,
    runtime: "runtime" in options ? options.runtime : { flavor: "local-binary" },
  };
  const server = await createLocalMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "stdio-bridge-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function firstText(call: { content?: unknown }): string {
  const content = (call.content ?? []) as Array<{ text?: string }>;
  return content[0]?.text ?? "";
}

function fixedClock(): ClockPort {
  return { nowMs: () => NOW_MS };
}

function stripAuthEnv(): () => void {
  const keys = [
    "CAPTATUM_FLAVOR",
    "DEPLOYMENT_FLAVOR",
    "OAUTH_ISSUER",
    "OAUTH_RESOURCE",
    "OAUTH_CONSENT_SIGNING_SECRET",
    "OAUTH_SIGNING_PRIVATE_JWK",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

class FakeFetcher implements FetcherPort {
  readonly calls: Array<{ url: string; opts: FetcherOptions }> = [];
  private readonly html: string;
  constructor(html: string) { this.html = html; }
  async fetchGuarded(url: string, opts: FetcherOptions): Promise<FetcherResult> {
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

class RejectingFetcher implements FetcherPort {
  private readonly code: string;
  private readonly message: string;
  constructor(code: string, message: string) { this.code = code; this.message = message; }
  async fetchGuarded(): Promise<RejectResult> {
    return { rejected: true, code: this.code, message: this.message };
  }
}

class FakeTransformer implements TransformPort {
  readonly calls: TransformInput[] = [];
  async transform(input: TransformInput): Promise<TransformResult> {
    this.calls.push(input);
    return { result: "summary text", info: { provider: "openrouter", model: "model" } };
  }
}

class NoopAudit implements AuditLoggerPort {
  async writeAuthEvent(): Promise<void> {}
  async writeToolEvent(): Promise<void> {}
}

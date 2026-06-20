import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuditLoggerPort } from "../application/ports/audit.ts";
import type { ClockPort } from "../application/ports/clock.ts";
import type { FetcherOptions, FetcherPort, FetcherResult } from "../application/ports/fetcher.ts";
import { extractHtml } from "../infrastructure/extract/index.ts";
import { createLocalMcpServer } from "../interfaces/mcp/local-server.ts";

const FIXTURE_TEXT = "smart-fetch shared smoke fixture content.";

class StdioSmokeFetcher implements FetcherPort {
  readonly calls: Array<{ url: string; opts: FetcherOptions }> = [];

  async fetchGuarded(url: string, opts: FetcherOptions): Promise<FetcherResult> {
    this.calls.push({ url, opts });
    const html = `<main><h1>Smoke</h1><p>${FIXTURE_TEXT}</p></main>`;
    const bytes = new TextEncoder().encode(html);
    return {
      status: 200,
      finalUrl: url,
      redirects: [],
      bodyStream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      contentType: "text/html; charset=utf-8",
      bytes: bytes.byteLength,
    };
  }
}

class StdioSmokeAudit implements AuditLoggerPort {
  async writeAuthEvent(): Promise<void> {}
  async writeToolEvent(): Promise<void> {}
}

const clock: ClockPort = { nowMs: () => Date.parse("2026-06-16T12:00:00.000Z") };
const fetcher = new StdioSmokeFetcher();

// Local-binary flavor only, with no OAUTH_* secrets present: must start cleanly.
const server = await createLocalMcpServer({
  fetcher,
  extractHtml,
  audit: new StdioSmokeAudit(),
  clock,
  runtime: { flavor: "local-binary" },
});

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "smart-fetch-stdio-smoke", version: "0.1.0" });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const tools = await client.listTools();
const tool = tools.tools.find((entry) => entry.name === "smart_fetch");
if (!tool || tool.inputSchema.additionalProperties !== false) {
  throw new Error("stdio smoke: local bridge did not expose the strict smart_fetch schema");
}

const call = await client.callTool({
  name: "smart_fetch",
  arguments: { url: "https://smoke.test/fixture", output: "raw" },
});
await client.close();
await server.close();

const content = (call.content ?? []) as Array<{ type: string; text?: string }>;
const text = content[0]?.text ?? "";
const result = call.structuredContent as Record<string, unknown> | undefined;

if (fetcher.calls.length !== 1) {
  throw new Error(`stdio smoke: expected one guarded fetch, saw ${fetcher.calls.length}`);
}
if (!text.startsWith("<!-- captatum ") || !text.includes(FIXTURE_TEXT)) {
  throw new Error(`stdio smoke: provenance/content missing from text: ${text}`);
}
assertContractShape(result);

console.log("--- smart-fetch local stdio bridge smoke ---");
console.log(text);
console.log(JSON.stringify({
  schemaVersion: result.schemaVersion,
  ok: result.ok,
  status: result.status,
  contentType: result.contentType,
  tier: result.tier,
  output: result.output,
  finalUrl: result.finalUrl,
  platform: (result.platform as { adapterId?: string }).adapterId,
  resolvedVia: result.resolvedVia,
  jsRequired: result.jsRequired,
  bytes: result.bytes,
  images: result.images,
  access: result.access,
}, null, 2));

function assertContractShape(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("stdio smoke: result is not contract-shaped structuredContent");
  }
  const record = value as Record<string, unknown>;
  const required = [
    "schemaVersion", "ok", "status", "finalUrl", "tier", "output",
    "platform", "resolvedVia", "jsRequired", "result", "contentType",
    "access", "provenance", "warnings", "images", "errors",
  ];
  const missing = required.filter((key) => !(key in record));
  if (missing.length) {
    throw new Error(`stdio smoke: result missing lean contract fields: ${missing.join(", ")}`);
  }
  // Heavy fields are debug-gated and must be absent from the default payload.
  const leaked = ["attempts", "timings", "structured", "redirects"]
    .filter((key) => key in record);
  if (leaked.length) {
    throw new Error(`stdio smoke: heavy fields leaked into default payload: ${leaked.join(", ")}`);
  }
  if (record.schemaVersion !== 1 || record.output !== "raw") {
    throw new Error(`stdio smoke: unexpected provenance schemaVersion/output: ${JSON.stringify(record)}`);
  }
}

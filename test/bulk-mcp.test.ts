import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { FetcherOptions, FetcherPort, FetcherResult, RejectResult } from "../src/application/ports/fetcher.ts";
import type { AuthAuditEvent, AuditLoggerPort, ToolAuditEvent } from "../src/application/ports/audit.ts";
import type { ClockPort } from "../src/application/ports/clock.ts";
import { extractHtml } from "../src/infrastructure/extract/index.ts";
import { createLocalMcpServer } from "../src/interfaces/mcp/local-server.ts";
import { callBulk } from "../src/interfaces/mcp/bulk-handler.ts";
import { AUTH_JSONRPC_CODE } from "../src/interfaces/jsonrpc-error-codes.ts";

const NOW_MS = Date.parse("2026-07-06T12:00:00.000Z");

/** A per-URL fetcher (the existing FakeFetcher returns one result for all URLs). */
class PerUrlFetcher implements FetcherPort {
  readonly results = new Map<string, FetcherResult>();
  readonly calls: string[] = [];
  async fetchGuarded(url: string, _opts: FetcherOptions): Promise<FetcherResult | RejectResult> {
    this.calls.push(url);
    const r = this.results.get(url);
    if (!r) return { rejected: true, code: "not_found", message: `no fake result for ${url}` };
    return r;
  }
}

function htmlResult(html: string, finalUrl: string): FetcherResult {
  const bytes = new TextEncoder().encode(html);
  return {
    status: 200, finalUrl, redirects: [],
    bodyStream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }),
    contentType: "text/html; charset=utf-8", bytes: bytes.byteLength,
  };
}

/** Content-bearing article HTML that resolves at Tier-1 (avoids the shell-gate's empty-shell
 *  trip, which would mark a minimal `<main>x</main>` page render-blocked). */
function article(title: string, body: string, finalUrl: string): FetcherResult {
  return htmlResult(
    `<html><head><title>${title}</title><meta name="description" content="${title}"></head><body><article><h1>${title}</h1><p>${body}</p></article></body></html>`,
    finalUrl,
  );
}

async function bootLocal(fetcher: PerUrlFetcher): Promise<{ client: Client; close: () => Promise<void>; audit: MemoryAudit }> {
  const clock: ClockPort = { nowMs: () => NOW_MS };
  const audit = new MemoryAudit();
  const server = await createLocalMcpServer({ fetcher, extractHtml, clock, audit, runtime: { flavor: "local-binary" } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, audit, close: async () => { await client.close(); await server.close(); } };
}

class MemoryAudit implements AuditLoggerPort {
  readonly toolEvents: ToolAuditEvent[] = [];
  async writeAuthEvent(_e: AuthAuditEvent): Promise<void> {}
  async writeToolEvent(e: ToolAuditEvent): Promise<void> { this.toolEvents.push(e); }
}

test("MCP: local server lists both captatum and captatum_bulk", async () => {
  const { client, close } = await bootLocal(new PerUrlFetcher());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["captatum", "captatum_bulk"]);
  await close();
});

test("MCP: captatum_bulk dispatches end-to-end (orchestrator → captatum → fetcher) + fenced text", async () => {
  const fetcher = new PerUrlFetcher();
  fetcher.results.set("https://a.test/x", article("Alpha", "This is the alpha article content with enough words to resolve at Tier-1.", "https://a.test/x"));
  fetcher.results.set("https://b.test/y", article("Beta", "This is the beta article content with enough words to resolve at Tier-1.", "https://b.test/y"));
  const { client, close, audit } = await bootLocal(fetcher);
  const res = await client.callTool({ name: "captatum_bulk", arguments: { urls: ["https://a.test/x", "https://b.test/y"] } });
  const text = (res.content as Array<{ type: string; text: string }>)[0].text;
  assert.match(text, /kind=bulk/, "provenance header present");
  assert.match(text, /fence=[0-9a-f]+/, "fence token in header");
  assert.match(text, /\[1\/2\] https:\/\/a\.test\/x/, "section 1 framed");
  assert.match(text, /\[2\/2\] https:\/\/b\.test\/y/, "section 2 framed");
  assert.match(text, /alpha article content/, "seed 1 content delivered");
  assert.match(text, /beta article content/, "seed 2 content delivered");
  const sc = res.structuredContent as Record<string, unknown>;
  assert.equal(sc.kind, "bulk");
  assert.equal(sc.count, 2);
  assert.equal(sc.status, "pass");
  assert.ok(typeof sc.fenceToken === "string" && (sc.fenceToken as string).length > 0);
  assert.deepEqual(fetcher.calls.sort(), ["https://a.test/x", "https://b.test/y"]);
  // Audit: 2 per-seed events + 1 summary event, all tool:"captatum_bulk" + bulkId.
  const bulk = audit.toolEvents.filter((e) => e.tool === "captatum_bulk");
  assert.equal(bulk.length, 3);
  assert.ok(bulk.every((e) => e.bulkId !== undefined));
  assert.equal(bulk.filter((e) => e.capBreaches !== undefined).length, 1, "exactly one summary event carries capBreaches");
  await close();
});

test("MCP: captatum_bulk rejects allowRender:true as a tool-level invalid_input (bulk_render_not_supported)", async () => {
  const { client, close } = await bootLocal(new PerUrlFetcher());
  await assert.rejects(
    client.callTool({ name: "captatum_bulk", arguments: { urls: ["https://a.test/x"], allowRender: true } }),
    (err: unknown) => err instanceof Error && /bulk_render_not_supported/.test(err.message),
  );
  await close();
});

test("MCP: captatum_bulk with a private-IP seed → per-seed FETCH_REJECTED, never a fetched body", async () => {
  // The fetcher returns a RejectResult for the private IP (simulating the SSRF guard), so the
  // bulk result has one fail entry and ZERO bytes for that seed — bulk never widens the guard.
  const fetcher = new PerUrlFetcher();
  fetcher.results.set("https://good.test/x", article("Good", "This is the good article content with enough words to resolve at Tier-1.", "https://good.test/x"));
  const { client, close } = await bootLocal(fetcher);
  const res = await client.callTool({ name: "captatum_bulk", arguments: { urls: ["https://good.test/x", "http://169.254.169.254/latest/meta-data/"] } });
  const sc = res.structuredContent as { count: number; status: string; results: Array<{ url: string; status: string; bytes: number; tier: string }> };
  assert.equal(sc.count, 2);
  assert.equal(sc.status, "partial");
  const privateSeed = sc.results.find((r) => r.url.includes("169.254"));
  assert.ok(privateSeed, "private-IP seed present in results");
  assert.equal(privateSeed!.status, "fail");
  assert.equal(privateSeed!.bytes, 0, "no body fetched for the private seed");
  assert.equal(privateSeed!.tier, "error");
  await close();
});

test("callBulk: an insufficient-scope rejection is audited + mapped to the auth JSON-RPC code (-32003), parity with callCaptatum", async () => {
  // requireScope is INSIDE callBulk's try (fix for the review finding): a hosted caller with
  // only fetch:read calling captatum_bulk with output:summary is rejected with the actionable
  // -32003 code AND leaves a 403 audit event — not a generic error + no silent audit gap.
  const audit = new MemoryAudit();
  const deps = {
    captatum: { execute: async () => { throw new Error("captatum must not run on a scope reject"); }, defaultOutput: "raw" },
    auth: { subject: "u", clientId: "c", scopes: ["fetch:read"] },
    audit, clock: { nowMs: () => NOW_MS } as ClockPort,
    bulk: { execute: async () => { throw new Error("bulk must not run on a scope reject"); } },
  } as unknown as Parameters<typeof callBulk>[1];
  await assert.rejects(
    callBulk({ urls: ["https://a.test/x"], output: "summary" }, deps),
    (err: unknown) => err instanceof McpError && err.code === AUTH_JSONRPC_CODE && /insufficient_scope/.test(err.message),
  );
  assert.equal(audit.toolEvents.length, 1, "the rejected bulk call left an audit event");
  assert.equal(audit.toolEvents[0].status, 403);
});

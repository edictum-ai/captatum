import { generateKeyPairSync } from "node:crypto";
import type { JWK } from "jose";
import type { FetcherOptions, FetcherPort, FetcherResult } from "../application/ports/fetcher.ts";
import type { ClockPort } from "../application/ports/clock.ts";
import type { AuditLoggerPort } from "../application/ports/audit.ts";
import type { StorePort } from "../application/ports/store.ts";
import type { HostedOAuthConfig } from "../application/use-cases/oauth-config.ts";
import { signAccessToken } from "../application/use-cases/oauth-crypto.ts";
import { createSmartFetchUseCase } from "../application/use-cases/smart-fetch.ts";
import { config } from "../config.ts";
import { extractHtml } from "../infrastructure/extract/index.ts";
import { createHttpApp } from "../interfaces/http/app.ts";

class SmokeFetcher implements FetcherPort {
  calls: Array<{ url: string; opts: FetcherOptions }> = [];

  async fetchGuarded(url: string, opts: FetcherOptions): Promise<FetcherResult> {
    this.calls.push({ url, opts });
    const html = "<main><h1>Smoke</h1><p>smart-fetch hosted MCP smoke fixture content.</p></main>";
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

class SmokeAudit implements AuditLoggerPort {
  async writeAuthEvent(): Promise<void> {}
  async writeToolEvent(): Promise<void> {}
}

class SmokeStore implements StorePort {
  async saveAuthCode(): Promise<void> {}
  async consumeAuthCode(): Promise<null> { return null; }
  async saveRefreshToken(): Promise<void> {}
  async rotateRefreshToken(): Promise<null> { return null; }
  async revokeRefreshTokenFamily(): Promise<void> {}
  async close(): Promise<void> {}
}

const clock: ClockPort = { nowMs: () => Date.parse("2026-06-16T12:00:00.000Z") };
const oauth = hostedConfig();
const token = await signAccessToken({
  subject: "smoke-user",
  clientId: "smoke-client",
  scopes: ["fetch:read"],
}, oauth, clock);
const fetcher = new SmokeFetcher();
const app = await createHttpApp({
  smartFetch: createSmartFetchUseCase({ fetcher, extractHtml, clock }),
  runtime: { flavor: "hosted", oauth },
  clock,
  audit: new SmokeAudit(),
  store: new SmokeStore(),
  allowedHosts: ["smart-fetch.test"],
  allowedOrigins: ["https://client.test"],
});

const response = await app.inject({
  method: "POST",
  url: config.mcp.endpointPath,
  headers: {
    authorization: `Bearer ${token}`,
    host: "smart-fetch.test",
    origin: "https://client.test",
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": config.mcp.stableProtocolVersion,
  },
  payload: {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "smart_fetch", arguments: { url: "https://smoke.test/fixture", output: "raw" } },
  },
});
await app.close();

if (response.statusCode !== 200 || fetcher.calls.length !== 1) {
  throw new Error(`smart-fetch MCP smoke failed: ${response.statusCode} ${response.body}`);
}
const body = response.json() as SmokeRpcResponse;
const text = body.result?.content?.[0]?.text;
if (!text?.includes("smart-fetch hosted MCP smoke fixture content")) {
  throw new Error(`smart-fetch MCP smoke returned unexpected body: ${response.body}`);
}
console.log(text);

function hostedConfig(): HostedOAuthConfig {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    issuer: "https://smart-fetch.test",
    resource: "https://smart-fetch.test/mcp",
    consentSigningSecret: "smoke-consent-secret-with-enough-entropy",
    signingPrivateJwk: { ...privateKey.export({ format: "jwk" }), alg: "ES256", kid: "smoke-key-1" } as JWK,
    signingKeyId: "smoke-key-1",
    redirectAllowlist: ["https://client.test/callback"],
    accessTokenTtlSeconds: 600,
    refreshTokenTtlSeconds: 2_592_000,
    consentTokenTtlSeconds: 300,
    authorizationCodeTtlSeconds: 300,
  };
}

interface SmokeRpcResponse {
  result?: { content?: Array<{ type: string; text?: string }> };
}

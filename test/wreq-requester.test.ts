import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { FetcherResult, RejectResult } from "../src/application/ports/fetcher.ts";
import type { DnsResolver, ResolvedAddress } from "../src/infrastructure/http/dns.ts";
import type { HttpRequester, HttpRequestInput } from "../src/infrastructure/http/request.ts";
import { createWreqGuardedFetcher } from "../src/infrastructure/wreq/requester.ts";

const SAFE_IP = "93.184.216.34";
const DEFAULT_OPTS = { maxBytes: 1024, timeoutMs: 500, maxHops: 5 };

test("wreq adapter HTTP path uses mocked wreq-js response shape", async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const fetcher = createWreqGuardedFetcher({
    resolver: resolverFor({ "public.test": [{ address: SAFE_IP, family: 4 }] }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init: init as Record<string, unknown> });
      return {
        status: 203,
        headers: [
          ["Content-Type", "text/plain; charset=utf-8"],
          ["X-Repeat", "one"],
          ["X-Repeat", "two"],
        ],
        body: webStream("wreq fixture"),
      };
    },
  });

  const result = await fetcher.fetchGuarded(
    "http://public.test:8080/path?q=1#secret",
    DEFAULT_OPTS,
  );

  assertResult(result);
  assert.equal(result.status, 203);
  assert.equal(result.finalUrl, "http://public.test:8080/path?q=1");
  assert.equal(result.contentType, "text/plain; charset=utf-8");
  assert.equal(result.bytes, Buffer.byteLength("wreq fixture"));
  assert.equal(await textOf(result), "wreq fixture");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://93.184.216.34:8080/path?q=1");

  const init = calls[0]?.init ?? {};
  assert.equal(init.redirect, "manual");
  assert.equal(init.timeout, DEFAULT_OPTS.timeoutMs);
  assert.equal(init.compress, false);
  assert.equal(init.cookieMode, "ephemeral");
  assert.equal(init.signal instanceof AbortSignal, true);
  assert.deepEqual(init.headers, {
    Host: "public.test:8080",
    "Accept-Encoding": "gzip, br, deflate",
    "User-Agent": "captatum/0.1",
  });
});

test("wreq adapter HTTPS path delegates to Node fallback decision", async () => {
  const wreqCalls: string[] = [];
  const fallback = new RecordingFallback();
  const fetcher = createWreqGuardedFetcher({
    resolver: resolverFor({ "secure.test": [{ address: SAFE_IP, family: 4 }] }),
    httpsFallback: fallback,
    fetchImpl: async (url) => {
      wreqCalls.push(url);
      throw new Error("HTTPS should not use wreq in the guarded adapter yet");
    },
  });

  const result = await fetcher.fetchGuarded("https://secure.test/path", DEFAULT_OPTS);

  assertResult(result);
  assert.equal(await textOf(result), "https fallback");
  assert.deepEqual(wreqCalls, []);
  assert.equal(fallback.calls.length, 1);
  assert.equal(fallback.calls[0]?.url.protocol, "https:");
  assert.equal(fallback.calls[0]?.address, SAFE_IP);
  assert.equal(fallback.calls[0]?.hostHeader, "secure.test");
});

test("guarded fetch fails closed on unclassifiable DNS answers", async () => {
  const fallback = new RecordingFallback();
  const fetcher = createWreqGuardedFetcher({
    resolver: resolverFor({ "broken.test": [{ address: "not-an-ip", family: 4 }] }),
    httpsFallback: fallback,
    fetchImpl: async () => {
      throw new Error("unclassifiable DNS answer reached wreq");
    },
  });

  const result = await fetcher.fetchGuarded("http://broken.test/", DEFAULT_OPTS);

  assertReject(result, "dns_error");
  assert.equal(fallback.calls.length, 0);
});

class RecordingFallback implements HttpRequester {
  readonly calls: HttpRequestInput[] = [];

  async request(input: HttpRequestInput) {
    this.calls.push(input);
    return {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: Readable.from(["https fallback"]),
    };
  }
}

function resolverFor(records: Record<string, ResolvedAddress[]>): DnsResolver {
  return {
    async lookup(hostname) {
      return records[hostname] ?? [];
    },
  };
}

function webStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function assertReject(result: FetcherResult | RejectResult, code: string): asserts result is RejectResult {
  assert.equal("rejected" in result && result.rejected, true, JSON.stringify(result));
  assert.equal(result.code, code);
}

function assertResult(result: FetcherResult | RejectResult): asserts result is FetcherResult {
  assert.equal("rejected" in result, false, JSON.stringify(result));
}

async function textOf(result: FetcherResult): Promise<string> {
  return await new Response(result.bodyStream).text();
}

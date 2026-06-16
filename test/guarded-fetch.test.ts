import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import type { FetcherResult, RejectResult } from "../src/application/ports/fetcher.ts";
import { isPrivate } from "../src/domain/policy.ts";
import type { DnsResolver, ResolvedAddress } from "../src/infrastructure/http/dns.ts";
import { GuardedFetchError } from "../src/infrastructure/http/errors.ts";
import { GuardedHttpFetcher } from "../src/infrastructure/http/guarded-fetcher.ts";
import type {
  HttpRequester,
  HttpRequestInput,
  HttpResponse,
} from "../src/infrastructure/http/request.ts";

const SAFE_IP = "93.184.216.34";
const DEFAULT_OPTS = { maxBytes: 1024, timeoutMs: 500, maxHops: 5 };

test("isPrivate blocks every threat-model IPv4 and IPv6 range", () => {
  for (const ip of [
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "0.1.2.3",
    "100.64.0.1",
    "100.127.255.255",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "fdff::1",
    "ff00::1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "::192.168.0.1",
  ]) {
    assert.equal(isPrivate(ip), true, ip);
  }

  for (const ip of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"]) {
    assert.equal(isPrivate(ip), false, ip);
  }
});

const payloads: Array<[string, string, string]> = [
  ["rejects file:// SSRF payload", "file:///etc/passwd", "unsupported_scheme"],
  ["rejects gopher:// SSRF payload", "gopher://example.test/", "unsupported_scheme"],
  ["rejects localhost SSRF payload", "http://localhost/", "private_address"],
  ["rejects 127.0.0.1 SSRF payload", "http://127.0.0.1/", "private_address"],
  ["rejects 169.254.169.254 SSRF payload", "http://169.254.169.254/latest", "private_address"],
  ["rejects ::1 SSRF payload", "http://[::1]/", "private_address"],
  [
    "rejects ::ffff:169.254.169.254 SSRF payload",
    "http://[::ffff:169.254.169.254]/",
    "private_address",
  ],
  ["rejects RFC1918 10/8 SSRF payload", "http://10.1.2.3/", "private_address"],
  ["rejects RFC1918 172.16/12 SSRF payload", "http://172.16.0.1/", "private_address"],
  ["rejects RFC1918 192.168/16 SSRF payload", "http://192.168.0.1/", "private_address"],
  ["rejects CRLF-bearing URL SSRF payload", "http://example.test/%0d%0aHost:evil", "crlf_url"],
  ["rejects userinfo-bearing URL SSRF payload", "http://user:pass@example.test/", "userinfo_url"],
];

for (const [name, url, code] of payloads) {
  test(name, async () => {
    const requester = new ScriptedRequester(() => {
      throw new Error("blocked payload reached requester");
    });
    const result = await new GuardedHttpFetcher({ requester }).fetchGuarded(url, DEFAULT_OPTS);
    assertReject(result, code);
    assert.equal(requester.calls.length, 0);
  });
}

test("blocks 302 redirect to 127.0.0.1 before the second request", async () => {
  const requester = new ScriptedRequester(() =>
    response(302, { location: "http://127.0.0.1/private" }),
  );
  const fetcher = new GuardedHttpFetcher({
    resolver: resolverFor({ "public.test": [{ address: SAFE_IP, family: 4 }] }),
    requester,
  });

  const result = await fetcher.fetchGuarded("http://public.test/start", DEFAULT_OPTS);

  assertReject(result, "private_address");
  assert.equal(requester.calls.length, 1);
});

test("DNS rebind stub connects to the checked IP instead of re-resolving", async () => {
  const resolver = new CountingResolver([[{ address: SAFE_IP, family: 4 }]]);
  const requester = new ScriptedRequester((input) =>
    response(200, { "content-type": "text/plain" }, `connected:${input.address}`),
  );

  const result = await new GuardedHttpFetcher({ resolver, requester })
    .fetchGuarded("http://rebind.test/resource", DEFAULT_OPTS);

  assertResult(result);
  assert.equal(requester.calls[0]?.address, SAFE_IP);
  assert.equal(await textOf(result), `connected:${SAFE_IP}`);
  assert.equal(resolver.calls.length, 1);
});

test("decompressed byte cap rejects oversized response bodies", async () => {
  const body = gzipSync("abcdef");
  const fetcher = new GuardedHttpFetcher({
    resolver: resolverFor({ "bytes.test": [{ address: SAFE_IP, family: 4 }] }),
    requester: new ScriptedRequester(() => response(200, { "content-encoding": "gzip" }, body)),
  });

  const result = await fetcher.fetchGuarded("http://bytes.test/", {
    ...DEFAULT_OPTS,
    maxBytes: 5,
  });

  assertReject(result, "max_bytes");
});

test("timeout aborts a stalled guarded fetch", async () => {
  const fetcher = new GuardedHttpFetcher({
    resolver: resolverFor({ "slow.test": [{ address: SAFE_IP, family: 4 }] }),
    requester: new ScriptedRequester((input) =>
      new Promise((_, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(new GuardedFetchError("timeout", "Fetch timed out")),
          { once: true },
        );
      }),
    ),
  });

  const result = await fetcher.fetchGuarded("http://slow.test/", {
    ...DEFAULT_OPTS,
    timeoutMs: 20,
  });

  assertReject(result, "timeout");
});

test("safe public HTTP fixture succeeds and returns fetch metadata", async () => {
  const fetcher = new GuardedHttpFetcher({
    resolver: resolverFor({ "safe.test": [{ address: SAFE_IP, family: 4 }] }),
    requester: new ScriptedRequester(() =>
      response(200, { "content-type": "text/plain; charset=utf-8" }, "safe fixture"),
    ),
  });

  const result = await fetcher.fetchGuarded("http://safe.test/path?q=1#frag", DEFAULT_OPTS);

  assertResult(result);
  assert.equal(result.status, 200);
  assert.equal(result.finalUrl, "http://safe.test/path?q=1");
  assert.deepEqual(result.redirects, []);
  assert.equal(result.contentType, "text/plain; charset=utf-8");
  assert.equal(result.bytes, Buffer.byteLength("safe fixture"));
  assert.equal(await textOf(result), "safe fixture");
});

test("parallel guarded fetches keep DNS and redirect state isolated", async () => {
  const requester = new ScriptedRequester((input) => {
    if (input.hostHeader === "a.test") {
      return response(302, { location: "http://b.test/final" });
    }
    return response(200, { "content-type": "text/plain" }, input.hostHeader);
  });
  const fetcher = new GuardedHttpFetcher({
    resolver: resolverFor({
      "a.test": [{ address: SAFE_IP, family: 4 }],
      "b.test": [{ address: SAFE_IP, family: 4 }],
      "c.test": [{ address: "93.184.216.35", family: 4 }],
    }),
    requester,
  });

  const [redirected, plain] = await Promise.all([
    fetcher.fetchGuarded("http://a.test/start", DEFAULT_OPTS),
    fetcher.fetchGuarded("http://c.test/", DEFAULT_OPTS),
  ]);

  assertResult(redirected);
  assertResult(plain);
  assert.deepEqual(redirected.redirects, [{ url: "http://b.test/final", status: 302 }]);
  assert.deepEqual(plain.redirects, []);
  assert.equal(await textOf(plain), "c.test");
});

class ScriptedRequester implements HttpRequester {
  readonly calls: HttpRequestInput[] = [];
  private readonly handler: (input: HttpRequestInput) => Promise<HttpResponse> | HttpResponse;

  constructor(handler: (input: HttpRequestInput) => Promise<HttpResponse> | HttpResponse) {
    this.handler = handler;
  }

  async request(input: HttpRequestInput): Promise<HttpResponse> {
    this.calls.push(input);
    return await this.handler(input);
  }
}

class CountingResolver implements DnsResolver {
  readonly calls: string[] = [];
  private readonly answers: ResolvedAddress[][];

  constructor(answers: ResolvedAddress[][]) {
    this.answers = answers;
  }

  async lookup(hostname: string): Promise<ResolvedAddress[]> {
    this.calls.push(hostname);
    return this.answers[Math.min(this.calls.length - 1, this.answers.length - 1)] ?? [];
  }
}

function resolverFor(records: Record<string, ResolvedAddress[]>): DnsResolver {
  return {
    async lookup(hostname) {
      return records[hostname] ?? [];
    },
  };
}

function response(
  status: number,
  headers: Record<string, string> = {},
  body: string | Buffer = "",
): HttpResponse {
  return { status, headers, body: Readable.from([body]) };
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

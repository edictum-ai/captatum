import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { FetcherResult, RejectResult } from "../src/application/ports/fetcher.ts";
import type { DnsResolver, ResolvedAddress } from "../src/infrastructure/http/dns.ts";
import { GuardedHttpFetcher } from "../src/infrastructure/http/guarded-fetcher.ts";
import type { HttpRequester, HttpRequestInput, HttpResponse } from "../src/infrastructure/http/request.ts";

const FIXTURE_PATH = join(process.cwd(), "test", "fixtures", "security", "ssrf-payloads.json");
const DEFAULT_OPTS = { maxBytes: 1024, timeoutMs: 500, maxHops: 5 };
const REQUIRED_DOC_PAYLOADS = [
  "169.254.169.254",
  "::ffff:169.254.169.254",
  "localhost",
  "gopher://",
  "file://",
  "302 -> 127.0.0.1",
  "DNS-rebind stub",
];

test("SSRF fixture suite covers every payload listed in docs/threat-model.md", () => {
  const payloads = loadPayloads().map((payload) => payload.docsPayload).sort();
  assert.deepEqual(payloads, [...REQUIRED_DOC_PAYLOADS].sort());
});

for (const payload of loadPayloads()) {
  test(`SSRF fixture blocks ${payload.name}`, async () => {
    const requester = new FixtureRequester(payload);
    const result = await new GuardedHttpFetcher({
      resolver: resolverFor(payload.resolver ?? {}),
      requester,
    }).fetchGuarded(payload.url, DEFAULT_OPTS);

    assertReject(result, payload.expectedCode);
    assert.equal(requester.calls.length, payload.expectedRequesterCalls ?? 0);
  });
}

class FixtureRequester implements HttpRequester {
  readonly calls: HttpRequestInput[] = [];
  private readonly payload: SsrfPayload;

  constructor(payload: SsrfPayload) {
    this.payload = payload;
  }

  async request(input: HttpRequestInput): Promise<HttpResponse> {
    this.calls.push(input);
    const response = this.payload.response;
    if (!response) throw new Error(`SSRF fixture reached requester: ${this.payload.name}`);
    return {
      status: response.status,
      headers: response.headers ?? {},
      body: Readable.from([response.body ?? ""]),
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

function assertReject(result: FetcherResult | RejectResult, code: string): asserts result is RejectResult {
  assert.equal("rejected" in result && result.rejected, true, JSON.stringify(result));
  assert.equal(result.code, code);
}

function loadPayloads(): SsrfPayload[] {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as SsrfPayload[];
}

interface SsrfPayload {
  name: string;
  url: string;
  expectedCode: string;
  docsPayload: string;
  resolver?: Record<string, ResolvedAddress[]>;
  response?: {
    status: number;
    headers?: Record<string, string>;
    body?: string;
  };
  expectedRequesterCalls?: number;
}

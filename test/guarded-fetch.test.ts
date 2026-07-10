import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import type { FetcherPort, FetcherResult, RejectResult } from "../src/application/ports/fetcher.ts";
import { isPrivate } from "../src/domain/policy.ts";
import type { DnsResolver, ResolvedAddress } from "../src/infrastructure/http/dns.ts";
import { GuardedFetchError } from "../src/infrastructure/http/errors.ts";
import { GuardedHttpFetcher } from "../src/infrastructure/http/guarded-fetcher.ts";
import { computeAntiBotEvidence } from "../src/infrastructure/http/antibot-evidence.ts";
import { FetcherRouteFulfiller } from "../src/infrastructure/render/route-fulfill.ts";
import { fetchTier1WithBodyReadRetry } from "../src/application/use-cases/captatum-util.ts";
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

test("decompressed byte cap truncates oversized response bodies (advisory, not fatal)", async () => {
  const body = gzipSync("abcdef");
  const fetcher = new GuardedHttpFetcher({
    resolver: resolverFor({ "bytes.test": [{ address: SAFE_IP, family: 4 }] }),
    requester: new ScriptedRequester(() => response(200, { "content-encoding": "gzip" }, body)),
  });

  const result = await fetcher.fetchGuarded("http://bytes.test/", {
    ...DEFAULT_OPTS,
    maxBytes: 5,
  });

  if ("rejected" in result) throw new Error(`expected truncation, got reject: ${result.code}`);
  assert.equal(result.truncated, true);
  assert.equal(result.bytes, 5);
});

// A body stream that delivers `parts` then breaks mid-read (a premature close /
// Content-Length mismatch / decompression truncation) — simulating the undici
// ClientPayloadError / ContentLengthError from #149. `immediate` breaks before any byte.
function breakingBody(parts: Buffer[], immediate = false): Readable {
  return new Readable({
    read() {
      if (immediate) { this.destroy(new Error("Response payload is not completed")); return; }
      const p = parts.shift();
      if (p) this.push(p);
      else this.destroy(new Error("Response payload is not completed"));
    },
  });
}

test("readCappedBody: mid-read truncation returns partial bytes + body_read_error, not a hard fail (#149)", async () => {
  // Teeth-check: before #149 this threw body_read_error and discarded the partial bytes
  // (the betterstack.com/careers repro — a summary came back tier:error instead of content).
  const fetcher = new GuardedHttpFetcher({
    resolver: resolverFor({ "break.test": [{ address: SAFE_IP, family: 4 }] }),
    requester: new ScriptedRequester(() => ({
      status: 200,
      headers: { "content-length": "100" }, // advertises more than the stream delivers
      body: breakingBody([Buffer.from("partial-content")]),
    })),
  });
  const result = await fetcher.fetchGuarded("http://break.test/", DEFAULT_OPTS);
  if ("rejected" in result) throw new Error(`expected partial content, got reject: ${result.code}`);
  // Partial content > none: the bytes that arrived before the break are returned.
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedReason, "body_read_error");
  assert.equal(result.bytes, "partial-content".length);
  assert.equal(await new Response(result.bodyStream).text(), "partial-content");
});

test("readCappedBody: a zero-bytes body_read_error (broke before any content) still rejects (#149)", async () => {
  // Only a mid-read truncation WITH partial bytes degrades to partial content. A stream that
  // breaks before delivering anything is a total failure → hard reject (no content to return).
  const fetcher = new GuardedHttpFetcher({
    resolver: resolverFor({ "empty.test": [{ address: SAFE_IP, family: 4 }] }),
    requester: new ScriptedRequester(() => ({ status: 200, headers: {}, body: breakingBody([], true) })),
  });
  const result = await fetcher.fetchGuarded("http://empty.test/", DEFAULT_OPTS);
  assertReject(result, "body_read_error");
});

test("readCappedBody: cap truncation is labelled truncatedReason 'cap' (clean prefix, not transport) (#149)", async () => {
  const body = gzipSync("abcdef");
  const fetcher = new GuardedHttpFetcher({
    resolver: resolverFor({ "bytes.test": [{ address: SAFE_IP, family: 4 }] }),
    requester: new ScriptedRequester(() => response(200, { "content-encoding": "gzip" }, body)),
  });
  const result = await fetcher.fetchGuarded("http://bytes.test/", { ...DEFAULT_OPTS, maxBytes: 5 });
  if ("rejected" in result) throw new Error(`expected truncation, got reject: ${result.code}`);
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedReason, "cap", "cap-truncation is distinct from a transport body_read_error");
});

test("fetchTier1WithBodyReadRetry: retries once on a zero-bytes body_read_error, single-fetch only (#149)", async () => {
  // Single-fetch (no signal): the 1st body_read_error reject → ONE retry; the retry's success wins.
  let calls = 0;
  const ok: FetcherResult = {
    status: 200, finalUrl: "http://x.test/", redirects: [],
    bodyStream: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    contentType: "text/html", bytes: 0,
  };
  const fetcher: FetcherPort = {
    async fetchGuarded() {
      calls += 1;
      return calls === 1 ? { rejected: true, code: "body_read_error", message: "broken" } as RejectResult : ok;
    },
  };
  const out = await fetchTier1WithBodyReadRetry(fetcher, "http://x.test/", DEFAULT_OPTS, undefined);
  assert.equal(calls, 2, "single-fetch (no signal) retries once on a body_read_error reject");
  if ("rejected" in out) throw new Error("expected the retry's success");
  assert.equal(out.status, 200);

  // Bulk (signal present): the retry is SKIPPED — the orchestrator can't reserve a transparent
  // in-execute retry's egress against the byte cap, so the bulk egress bound stays airtight.
  let bulkCalls = 0;
  const bulkFetcher: FetcherPort = {
    async fetchGuarded() { bulkCalls += 1; return { rejected: true, code: "body_read_error", message: "broken" } as RejectResult; },
  };
  const out2 = await fetchTier1WithBodyReadRetry(bulkFetcher, "http://x.test/", DEFAULT_OPTS, new AbortController().signal);
  assert.equal(bulkCalls, 1, "bulk (signal present) does NOT retry — egress bound stays airtight");
  assertReject(out2, "body_read_error");
});

test("FetcherRouteFulfiller: a mid-read-truncated subresource is rejected, not fulfilled with partial bytes (#149)", async () => {
  // Teeth-check for the Tier-3 sibling: a half-loaded JS/CSS bundle can corrupt a render worse
  // than an aborted request, so a transport-truncated subresource is rejected. Without the
  // route-fulfill guard resolve() would fulfill the partial bodyStream.
  const truncatedResult: FetcherResult = {
    status: 200, finalUrl: "https://sub.test/x.js", redirects: [],
    bodyStream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("half-a-script")); c.close(); } }),
    contentType: "text/javascript", bytes: 13, truncated: true, truncatedReason: "body_read_error",
  };
  const fulfiller = new FetcherRouteFulfiller(
    { async fetchGuarded() { return truncatedResult; } },
    DEFAULT_OPTS,
  );
  const out = await fulfiller.resolve("https://sub.test/x.js", "script");
  assert.equal(out.kind, "reject");
  if (out.kind === "reject") {
    assert.equal(out.reject.code, "body_read_error");
    // The partial bytes were already downloaded — carried on the reject so the render byte pool
    // counts them (route-state's countFetched only runs on the fulfill path). Teeth-check: without
    // countedBytes the budget underreports a truncated subresource's egress (#149 codex P2).
    assert.equal(out.countedBytes, 13);
    assert.equal(out.countedFinalUrl, "https://sub.test/x.js");
  }

  // A cap-truncated subresource (a clean prefix) is still fulfilled — the distinction is load-bearing.
  const capFulfiller = new FetcherRouteFulfiller(
    { async fetchGuarded() { return { ...truncatedResult, truncatedReason: "cap" }; } },
    DEFAULT_OPTS,
  );
  const capOut = await capFulfiller.resolve("https://sub.test/x.js", "script");
  assert.equal(capOut.kind, "fulfill");
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

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

test("POST body forwards on the initial request and is DROPPED on a 3xx redirect (#111 SSRF HIGH)", async () => {
  // The body-drop guard: method/body apply to the INITIAL request only, so the page-authored
  // POST body can never reach a redirect target host. The POST gate lives in route-state; this
  // test pins the fetcher-level guarantee that a redirect hop reverts to GET + no body.
  const requester = new ScriptedRequester((input) => {
    if (input.url.hostname === "api.example.test") return response(302, { location: "https://other.example.test/land" });
    return response(200, { "content-type": "text/plain" }, "ok");
  });
  const fetcher = new GuardedHttpFetcher({
    resolver: resolverFor({
      "api.example.test": [{ address: SAFE_IP, family: 4 }],
      "other.example.test": [{ address: SAFE_IP, family: 4 }],
    }),
    requester,
  });
  const result = await fetcher.fetchGuarded("https://api.example.test/start", DEFAULT_OPTS, {
    method: "POST", body: enc('{"secret":"x"}'), requestContentType: "application/json",
  });
  assertResult(result);
  assert.equal(requester.calls.length, 2, "followed the redirect");
  // Initial request carried the POST body + Content-Type.
  assert.equal(requester.calls[0].method, "POST");
  assert.equal(Buffer.from(requester.calls[0].body!).toString(), '{"secret":"x"}');
  assert.equal(requester.calls[0].requestContentType, "application/json");
  // Redirect hop: GET (method undefined -> default) + NO body — the body never reaches other.example.test.
  assert.equal(requester.calls[1].method, undefined, "redirect reverts to GET");
  assert.equal(requester.calls[1].body, undefined, "POST body must NOT leak to the redirect target");
  assert.equal(requester.calls[1].requestContentType, undefined);
});

test("307/308 redirects revert the POST to GET + no body (deliberate RFC 7231 deviation, #111)", async () => {
  // 307/308 preserve method+body per RFC 7231; captatum deviates deliberately (SSRF/data-leak guard).
  for (const status of [301, 302, 307, 308]) {
    const requester = new ScriptedRequester((input) => {
      if (input.url.hostname === "api.example.test") return response(status, { location: "https://other.example.test/land" });
      return response(200, { "content-type": "text/plain" }, "ok");
    });
    const fetcher = new GuardedHttpFetcher({
      resolver: resolverFor({
        "api.example.test": [{ address: SAFE_IP, family: 4 }],
        "other.example.test": [{ address: SAFE_IP, family: 4 }],
      }),
      requester,
    });
    await fetcher.fetchGuarded("https://api.example.test/start", DEFAULT_OPTS, { method: "POST", body: enc("x"), requestContentType: "text/plain" });
    assert.equal(requester.calls[1].method, undefined, `${status}: redirect reverts to GET`);
    assert.equal(requester.calls[1].body, undefined, `${status}: body dropped on redirect`);
  }
});

test("GET requests carry no method/body when postInit is omitted (backward-compat, #111)", async () => {
  const requester = new ScriptedRequester(() => response(200, { "content-type": "text/plain" }, "ok"));
  const fetcher = new GuardedHttpFetcher({ resolver: resolverFor({ "api.example.test": [{ address: SAFE_IP, family: 4 }] }), requester });
  const result = await fetcher.fetchGuarded("https://api.example.test/start", DEFAULT_OPTS);
  assertResult(result);
  assert.equal(requester.calls[0].method, undefined);
  assert.equal(requester.calls[0].body, undefined);
  assert.equal(requester.calls[0].requestContentType, undefined);
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

// --- #151: computeAntiBotEvidence — vendor challenge markers + the status/non-JSON phrase gate ---
// Pure-function tests of the detection layer (the regexes + gates). The full classification flow
// (stamp → classify → gateReason) is covered by test/antibot.test.ts + test/acceptance/151/.

const ev = (status: number, body: string, headers: Record<string, string> = {}) =>
  computeAntiBotEvidence(headers, Buffer.from(body, "utf8"), status);

test("#151: DataDome CHALLENGE marker (captcha-delivery) is detected; the bare SDK tag is NOT (FP guard)", () => {
  assert.equal(ev(403, `<script src="https://ct.captcha-delivery.com/c.js"></script>`).hasChallengeBody, true);
  assert.equal(ev(403, `<script src="https://ct.captcha-delivery.com/c.js"></script>`).hasDataDomeBody, true);
  // A passing DataDome-protected page carries only the SDK tag (an external script) in its bodyHead.
  assert.equal(ev(200, `<script src="https://js.datadome.co/tags.js" async></script>real content`).hasChallengeBody, false);
  assert.equal(ev(200, `<script src="https://js.datadome.co/tags.js" async></script>real content`).hasDataDomeBody, false);
});

test("#151: Imperva BLOCK marker (Incapsula incident ID) is detected; the inline sensor is NOT (FP guard)", () => {
  assert.equal(ev(403, `Request unsuccessful. Incapsula incident ID: 1234. Powered By Incapsula`).hasChallengeBody, true);
  assert.equal(ev(403, `Request unsuccessful. Incapsula incident ID: 1234. Powered By Incapsula`).hasImpervaBody, true);
  // A passing Imperva-protected page carries only the inline SWJIYLWA sensor.
  assert.equal(ev(200, `<script src="/_Incapsula_Resource?SWJIYLWA=719abc"></script>real content`).hasChallengeBody, false);
  assert.equal(ev(200, `<script src="/_Incapsula_Resource?SWJIYLWA=719abc"></script>real content`).hasImpervaBody, false);
});

test("#151: existing Cloudflare/Akamai/PerimeterX markers still detected (no regression)", () => {
  assert.equal(ev(403, `<script src="/cdn-cgi/challenge-platform/h/g/jsch.js"></script>`, { "cf-mitigated": "challenge" }).hasChallengeBody, true);
  assert.equal(ev(403, `<script>_abck</script>`, { server: "AkamaiGH" }).serverVendor, "akamai");
  assert.equal(ev(403, `<div id="px-captcha"></div>`).hasChallengeBody, true);
});

test("#151: verification phrase fires ONLY at 429/503 AND non-JSON (the two FP controls)", () => {
  const phraseBody = `<body>We are verifying your browser. Please wait.</body>`;
  assert.equal(ev(429, phraseBody).hasVerificationPhrase, true);
  assert.equal(ev(503, phraseBody).hasVerificationPhrase, true);
  // Status gate: a 200 page with the phrase is NOT gated.
  assert.equal(ev(200, phraseBody).hasVerificationPhrase, false);
  // JSON gate: a 429 JSON API error with the phrase is NOT gated.
  assert.equal(ev(429, `{"detail":"verifying your browser"}`, { "content-type": "application/json" }).hasVerificationPhrase, false);
  assert.equal(ev(429, `{"detail":"verifying your browser"}`, { "content-type": "application/vnd.api+json" }).hasVerificationPhrase, false);
});

test("#151: a marker past the 4096-byte bodyHead cap is not detected", () => {
  assert.equal(ev(403, "x".repeat(4096) + "captcha-delivery").hasChallengeBody, false);
  assert.equal(ev(429, "x".repeat(4096) + "verifying your browser").hasVerificationPhrase, false);
});

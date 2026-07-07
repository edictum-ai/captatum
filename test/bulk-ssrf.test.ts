import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { DnsResolver, ResolvedAddress } from "../src/infrastructure/http/dns.ts";
import { GuardedHttpFetcher } from "../src/infrastructure/http/guarded-fetcher.ts";
import type { HttpRequester, HttpRequestInput, HttpResponse } from "../src/infrastructure/http/request.ts";
import { extractHtml } from "../src/infrastructure/extract/index.ts";
import { createCaptatumUseCase } from "../src/application/use-cases/captatum.ts";
import { createCaptatumBulkUseCase } from "../src/application/use-cases/captatum-bulk.ts";
import { createAdapterRegistry } from "../src/application/adapters.ts";
import type { ClockPort } from "../src/application/ports/clock.ts";

/**
 * BULK-GATE (b): the captatum_bulk orchestrator must NEVER widen the SSRF guard. 50 seeds
 * spanning every private-IP class + a redirect-to-private funnel through the REAL
 * GuardedHttpFetcher (the production SSRF chokepoint). Every private seed must be a per-seed
 * FETCH_REJECTED with ZERO bytes — never a fetched body — and the requester must never be
 * called for a private target (the guard rejects at resolve). No network: literal private IPs
 * reject without DNS, and the one public seed's 302→private is rejected at the redirect hop.
 */
test("BULK-GATE (b): 50 SSRF seeds → ZERO private-IP egress (every private seed FETCH_REJECTED)", async () => {
  const requester = new RecordingRequester();
  requester.set("public.test", { status: 302, headers: { location: "http://127.0.0.1/private" }, body: "" });
  const resolver: DnsResolver = {
    async lookup(hostname) {
      if (hostname === "public.test") return [{ address: "93.184.216.34", family: 4 }];
      return []; // literal IPs are handled by the guard without DNS; unknown → fail-closed
    },
  };
  const fetcher = new GuardedHttpFetcher({ resolver, requester });
  const clock: ClockPort = { nowMs: () => 1000 };
  const captatum = createCaptatumUseCase({ fetcher, extractHtml, clock });
  const bulk = createCaptatumBulkUseCase({ executor: captatum, adapters: createAdapterRegistry(), clock, operator: { maxPerHostInflight: 50 } });

  // 49 private-IP literals (every RFC-1918/loopback/link-local class, repeated to 49) + 1 public
  // hostname that 302→127.0.0.1 (the redirect-to-private path). All must be rejected per-seed.
  const privateIps = [
    "https://169.254.169.254/latest/meta-data", "https://127.0.0.1/admin", "https://10.0.0.1/",
    "https://192.168.1.1/", "https://172.16.0.1/", "https://[::1]/", "https://[::ffff:169.254.169.254]/",
  ];
  const seeds: string[] = [];
  for (let i = 0; i < 49; i++) seeds.push(privateIps[i % privateIps.length] + `?i=${i}`);
  seeds.push("https://public.test/start"); // 302 → 127.0.0.1/private

  const res = await bulk.execute({ urls: seeds });

  assert.equal(res.count, 50);
  assert.equal(res.failed, 50, "every SSRF seed failed");
  assert.equal(res.passed, 0);
  assert.equal(res.status, "fail");
  // ZERO private-IP egress: no seed returned a body.
  assert.equal(res.results.every((r) => r.bytes === 0), true, "no seed fetched a body");
  assert.equal(res.results.every((r) => r.tier === "error"), true, "every seed is tier:error");
  // The requester was called for the PUBLIC redirect SOURCE only — never for the private target.
  const hosts = requester.calls.map((c) => c.url.hostname).sort();
  assert.deepEqual([...new Set(hosts)], ["public.test"], "only the public redirect source was fetched; the private target was never reached");
  // The redirect-to-private seed is itself rejected (the guard followed + blocked the private hop).
  const redirectSeed = res.results.find((r) => r.url.includes("public.test"));
  assert.ok(redirectSeed);
  assert.equal(redirectSeed!.status, "fail");
});

test("BULK-GATE (b): redirect-to-private is blocked at the redirect hop (no private-target egress)", async () => {
  // Focused variant: a single public seed whose 302 points at a private IP. The guard follows the
  // redirect, re-resolves the private target, and rejects — the requester is called once (public)
  // and NEVER for 127.0.0.1.
  const requester = new RecordingRequester();
  requester.set("public.test", { status: 302, headers: { location: "http://10.0.0.99/secret" }, body: "" });
  const fetcher = new GuardedHttpFetcher({ resolver: staticResolver({ "public.test": [{ address: "93.184.216.34", family: 4 }] }), requester });
  const clock: ClockPort = { nowMs: () => 1000 };
  const captatum = createCaptatumUseCase({ fetcher, extractHtml, clock });
  const bulk = createCaptatumBulkUseCase({ executor: captatum, adapters: createAdapterRegistry(), clock, operator: {} });
  const res = await bulk.execute({ urls: ["https://public.test/start"] });
  assert.equal(res.count, 1);
  assert.equal(res.results[0].status, "fail");
  assert.equal(res.results[0].bytes, 0);
  assert.deepEqual([...new Set(requester.calls.map((c) => c.url.hostname))], ["public.test"]);
});

class RecordingRequester implements HttpRequester {
  readonly calls: HttpRequestInput[] = [];
  private readonly responses = new Map<string, { status: number; headers?: Record<string, string>; body?: string }>();
  set(host: string, response: { status: number; headers?: Record<string, string>; body?: string }): void {
    this.responses.set(host, response);
  }
  async request(input: HttpRequestInput): Promise<HttpResponse> {
    this.calls.push(input);
    const r = this.responses.get(input.url.hostname);
    if (!r) throw new Error(`no fixture response for ${input.url.hostname}`);
    return { status: r.status, headers: r.headers ?? {}, body: Readable.from([r.body ?? ""]) };
  }
}

function staticResolver(records: Record<string, ResolvedAddress[]>): DnsResolver {
  return { async lookup(hostname) { return records[hostname] ?? []; } };
}

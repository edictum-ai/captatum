import assert from "node:assert/strict";
import { test } from "node:test";
import { LimitingFetcher } from "../src/infrastructure/http/limiting-fetcher.ts";
import type { FetcherOptions, FetcherPort, FetcherResult, PostInit, RejectResult } from "../src/application/ports/fetcher.ts";

const OPTS: FetcherOptions = { maxBytes: 1024, timeoutMs: 5000, maxHops: 3 };

function result(url: string): FetcherResult {
  const bytes = new TextEncoder().encode("x");
  return {
    status: 200, finalUrl: url, redirects: [],
    bodyStream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }),
    contentType: "text/plain", bytes: bytes.byteLength,
  };
}

/** A fake inner fetcher that records peak concurrency + never resolves until told, so the
 *  LimitingFetcher's concurrency bound is observable. */
class TrackingFetcher implements FetcherPort {
  active = 0;
  peak = 0;
  readonly calls: string[] = [];
  /** Resolve gates: one per in-flight call. Each call awaits its gate. */
  private gates: Array<() => void> = [];
  async fetchGuarded(url: string, opts: FetcherOptions, postInit?: PostInit): Promise<FetcherResult | RejectResult> {
    this.calls.push(url);
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    const recordedOpts = opts; // captured for assertions
    void recordedOpts;
    void postInit;
    await new Promise<void>((resolve) => this.gates.push(resolve));
    this.active--;
    return result(url);
  }
  /** Release the N oldest in-flight calls. */
  release(n = 1): void { for (let i = 0; i < n && this.gates.length; i++) this.gates.shift()!(); }
  get pending(): number { return this.gates.length; }
}

test("LimitingFetcher: bounds concurrent fetchGuarded calls to capacity (BULK-2)", async () => {
  const inner = new TrackingFetcher();
  const lim = new LimitingFetcher(inner, 2);
  // Issue 3 concurrent calls; only 2 reach the inner fetcher (the 3rd waits for a slot).
  const p = [lim.fetchGuarded("https://1.test/", OPTS), lim.fetchGuarded("https://2.test/", OPTS), lim.fetchGuarded("https://3.test/", OPTS)];
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(inner.peak, 2, "only capacity=2 calls ran concurrently in the inner fetcher");
  assert.equal(inner.active, 2, "the 3rd is queued at the LimitingFetcher (not in the inner fetcher)");
  // Release one → the 3rd gets the slot.
  inner.release(1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(inner.peak, 2, "concurrency never exceeded capacity");
  inner.release(2);
  await Promise.all(p);
  assert.equal(inner.calls.length, 3, "all 3 eventually ran");
});

test("LimitingFetcher: a fetch that cannot get a slot within timeoutMs rejects as timeout", async () => {
  const inner = new TrackingFetcher();
  const lim = new LimitingFetcher(inner, 1);
  const first = lim.fetchGuarded("https://1.test/", { ...OPTS, timeoutMs: 1000 });
  await new Promise((r) => setTimeout(r, 20)); // first holds the only slot
  // Second call: capacity full, timeoutMs=50 → should reject as timeout quickly.
  const second = await lim.fetchGuarded("https://2.test/", { ...OPTS, timeoutMs: 50 });
  assert.ok(("rejected" in second) && second.rejected, "the over-capacity call rejected");
  if ("rejected" in second) assert.equal(second.code, "timeout", "reject code is timeout");
  inner.release(1);
  await first;
});

test("LimitingFetcher: a caller abort signal yanks a queued fetch (no hang past the wall)", async () => {
  const inner = new TrackingFetcher();
  const lim = new LimitingFetcher(inner, 1);
  const first = lim.fetchGuarded("https://1.test/", { ...OPTS, timeoutMs: 10_000 });
  await new Promise((r) => setTimeout(r, 20)); // first holds the slot
  const ac = new AbortController();
  const secondP = lim.fetchGuarded("https://2.test/", { ...OPTS, timeoutMs: 10_000, signal: ac.signal });
  ac.abort(); // the bulk wall fires while queued
  const second = await secondP;
  assert.ok(("rejected" in second) && second.rejected, "the aborted queued call rejected");
  inner.release(1);
  await first;
});

test("LimitingFetcher: an ALREADY-aborted signal rejects before queueing (no dead waiter) (codex R8 P2)", async () => {
  const inner = new TrackingFetcher();
  const lim = new LimitingFetcher(inner, 1);
  const first = lim.fetchGuarded("https://1.test/", { ...OPTS, timeoutMs: 10_000 });
  await new Promise((r) => setTimeout(r, 20)); // first holds the only slot (capacity full)
  const ac = new AbortController(); ac.abort(); // already aborted (bulk wall already fired)
  // An already-aborted signal must reject immediately (no slot, no queueing) — was: a born-aborted
  // AbortSignal.any doesn't fire addEventListener("abort"), leaving a dead waiter queued.
  const second = await lim.fetchGuarded("https://2.test/", { ...OPTS, timeoutMs: 10_000, signal: ac.signal });
  assert.ok(("rejected" in second) && second.rejected, "the already-aborted call rejected without queueing");
  assert.equal(inner.calls.length, 1, "the aborted call never reached the inner fetcher");
  // The waiter queue must be empty (the aborted call did not leave a dead waiter).
  assert.equal(inner.pending, 1, "no dead waiter left queued (only the first's gate is pending)");
  inner.release(1);
  await first;
});

test("LimitingFetcher: delegates to the inner fetcher (SSRF/redirect/Retry-After live there) + passes opts/postInit", async () => {
  let received: { url: string; opts: FetcherOptions; postInit?: PostInit } | undefined;
  const inner: FetcherPort = {
    async fetchGuarded(url: string, opts: FetcherOptions, postInit?: PostInit): Promise<FetcherResult | RejectResult> {
      received = { url, opts, postInit };
      return result(url);
    },
  };
  const lim = new LimitingFetcher(inner, 4);
  const postInit: PostInit = { method: "POST", body: new Uint8Array([1]) };
  const out = await lim.fetchGuarded("https://a.test/x", OPTS, postInit);
  assert.ok(!("rejected" in out), "delegated successfully");
  assert.equal(received!.url, "https://a.test/x");
  assert.equal(received!.postInit, postInit, "postInit forwarded to the inner fetcher");
});

test("LimitingFetcher: rejects a non-positive capacity at construction", () => {
  assert.throws(() => new LimitingFetcher({} as FetcherPort, 0), /capacity/);
  assert.throws(() => new LimitingFetcher({} as FetcherPort, 1.5), /capacity/);
});

test("LimitingFetcher: 20 concurrent calls through capacity-4 complete without deadlock + peak ≤ 4 (BULK-2 under load)", async () => {
  // Simulates concurrent bulk seeds fanning through the global cap. Each inner fetch auto-completes
  // after a short delay, so the queue churns through the handoff path repeatedly under load.
  let peak = 0;
  let active = 0;
  const lim = new LimitingFetcher({
    async fetchGuarded(url: string): Promise<FetcherResult | RejectResult> {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5)); // each fetch completes after 5ms
      active--;
      return result(url);
    },
  }, 4);
  const urls = Array.from({ length: 20 }, (_, i) => `https://${i}.test/`);
  const out = await Promise.all(urls.map((u) => lim.fetchGuarded(u, { ...OPTS, timeoutMs: 5000 })));
  assert.equal(out.length, 20, "all 20 calls completed (no deadlock)");
  assert.ok(peak <= 4, `peak concurrency never exceeded capacity 4; got ${peak}`);
  assert.ok(peak >= 4, `the cap was actually exercised (peak reached capacity); got ${peak}`);
});

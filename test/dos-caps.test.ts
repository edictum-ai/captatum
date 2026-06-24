import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSmartFetchInput } from "../src/application/use-cases/smart-fetch-input.ts";
import { AdmissionLimiter } from "../src/interfaces/http/mcp-route.ts";

test("timeoutMs is clamped to the server hard cap (DOS-1)", () => {
  // A caller could previously set timeoutMs to ~24.8 days (2^31-1 ms), pinning a
  // socket/connection for the duration. It must now clamp to 60s.
  const capped = normalizeSmartFetchInput({ url: "https://example.test/", timeoutMs: 2_147_483_647 });
  assert.equal(capped.timeoutMs, 60_000, "timeoutMs must clamp to the 60s hard cap");
  assert.equal(capped.renderTimeoutMs, 60_000, "renderTimeoutMs must clamp too");
});

test("a normal timeoutMs passes through unchanged", () => {
  assert.equal(normalizeSmartFetchInput({ url: "https://example.test/", timeoutMs: 5_000 }).timeoutMs, 5_000);
});

test("AdmissionLimiter caps concurrency and recovers on release (DOS-2)", () => {
  const limiter = new AdmissionLimiter(2);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), false, "an acquire over capacity must be rejected");
  limiter.release();
  assert.equal(limiter.tryAcquire(), true, "release frees a slot");
  limiter.release();
  limiter.release();
});

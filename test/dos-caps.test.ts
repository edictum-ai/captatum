import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCaptatumInput } from "../src/application/use-cases/captatum-input.ts";
import { AdmissionLimiter, withAdmission } from "../src/interfaces/http/mcp-route.ts";
import { OverloadedError, toMcpError } from "../src/interfaces/mcp/server.ts";

test("timeoutMs is clamped to the server hard cap (DOS-1)", () => {
  // A caller could previously set timeoutMs to ~24.8 days (2^31-1 ms), pinning a
  // socket/connection for the duration. It must now clamp to 60s.
  const capped = normalizeCaptatumInput({ url: "https://example.test/", timeoutMs: 2_147_483_647 });
  assert.equal(capped.timeoutMs, 60_000, "timeoutMs must clamp to the 60s hard cap");
  assert.equal(capped.renderTimeoutMs, 60_000, "renderTimeoutMs must clamp too");
});

test("a normal timeoutMs passes through unchanged", () => {
  assert.equal(normalizeCaptatumInput({ url: "https://example.test/", timeoutMs: 5_000 }).timeoutMs, 5_000);
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

// #84: an over-cap admission call must surface as a DISTINCT RETRYABLE JSON-RPC error, not the
// generic InternalError it used to collapse to.

test("withAdmission throws OverloadedError at capacity and delegates when under it (#84)", async () => {
  const limiter = new AdmissionLimiter(1);
  // Under capacity: delegates to inner and releases the slot.
  let called = false;
  const inner = { execute: async () => { called = true; return "ok"; }, defaultOutput: "raw" as const };
  const wrapped = withAdmission(inner as never, limiter);
  const out = await wrapped.execute({} as never, {} as never);
  assert.equal(out, "ok");
  assert.equal(called, true);
  assert.equal(limiter.tryAcquire(), true, "the slot was released after a successful call");
  // Now full again — an over-cap call rejects with OverloadedError (inner never runs).
  const inner2 = { execute: async () => "should-not-run", defaultOutput: "raw" as const };
  await assert.rejects(
    withAdmission(inner2 as never, limiter).execute({} as never, {} as never),
    (err: unknown) => err instanceof OverloadedError,
  );
});

test("toMcpError maps OverloadedError to a distinct retryable JSON-RPC code, leaving other mappings intact (#84)", () => {
  const err = new OverloadedError("captatum: server overloaded — too many concurrent captatum calls");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "OverloadedError");
  assert.equal(err.retryable, true);

  const mapped = toMcpError(err);
  assert.equal(mapped.code, -32050, "distinct from auth -32003 and SDK InternalError -32603");
  assert.equal(mapped.data?.retryable, true);
  assert.match(mapped.message, /overloaded/);

  // No regression: a plain Error still collapses to InternalError (-32603) with no data.
  const plain = toMcpError(new Error("boom"));
  assert.equal(plain.code, -32603);
  assert.equal(plain.data, undefined);
});

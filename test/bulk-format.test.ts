import assert from "node:assert/strict";
import { test } from "node:test";
import type { BulkResult, BulkSeedResult } from "../src/domain/bulk-result.ts";
import { BULK_GUARD_DEFAULTS } from "../src/domain/bulk-policy.ts";
import { bulkResultToMcpText } from "../src/interfaces/mcp/bulk-format.ts";
import { buildBulkStructuredContent } from "../src/interfaces/mcp/bulk-shape.ts";

const FENCE = "deadbeefcafef00d";

function makeSeed(i: number, contentChars: number): BulkSeedResult {
  const content = "x".repeat(contentChars);
  return {
    url: `https://h${i % 5}.test/p${i}`, finalUrl: `https://h${i % 5}.test/p${i}`,
    status: "pass", tier: 1, code: 200, codeText: "OK", bytes: contentChars, egressBytes: contentChars,
    output: "raw", platform: "generic", jsRequired: false, resolvedVia: "tier1-text", redirectHosts: [],
    contentSha256: "a".repeat(16), result: content.slice(0, 500), content, warnings: [], errors: [],
  };
}

function makeBulk(count: number, contentChars: number): BulkResult {
  const results = Array.from({ length: count }, (_, i) => makeSeed(i, contentChars));
  return {
    schemaVersion: 1, kind: "bulk", bulkId: "bulk-test", ok: true, status: "pass",
    count, passed: count, failed: 0, truncated: 0, deduped: 0,
    totals: { bytes: count * contentChars, egressBytes: count * contentChars, durationMs: 1234, transformInTokens: 0, transformOutTokens: 0, transformCostUsd: 0 },
    guard: BULK_GUARD_DEFAULTS, capBreaches: [], clamp: { inputUrls: count, afterDedupe: count, afterPerHostCap: count, processed: count, perHostTruncated: [], totalClampedTo: null },
    fenceToken: FENCE, results, failures: [], warnings: [], errors: [],
  };
}

test("bulk text: provenance header carries kind=bulk + the fence token; sections are fence-framed", () => {
  const text = bulkResultToMcpText(makeBulk(2, 50));
  assert.match(text, /^<!-- captatum kind=bulk count=2.*fence=deadbeefcafef00d -->/);
  assert.match(text, /\[1\/2\] https:\/\/h0\.test\/p0 \(fence=deadbeefcafef00d\)/);
  assert.match(text, /\[2\/2\] https:\/\/h1\.test\/p1 \(fence=deadbeefcafef00d\)/);
  assert.match(text, /=== end \(fence=deadbeefcafef00d\) ===/);
});

test("bulk text: capped at 50 KB (a 50×8 KB bulk would be ~400 KB uncapped)", () => {
  const text = bulkResultToMcpText(makeBulk(50, 8_000));
  assert.ok(text.length <= 50_000, `text length ${text.length} exceeds the 50 KB cap`);
});

test("bulk structured: small bulk keeps per-entry result snippets", () => {
  const sc = buildBulkStructuredContent(makeBulk(3, 100));
  const rows = sc.results as Array<{ result?: string }>;
  assert.ok(rows.every((r) => r.result !== undefined), "each row has a result snippet");
});

test("bulk structured: large bulk drops per-entry snippets to stay under ~25 KB", () => {
  // 50 entries × 8 KB content; with snippets the structured payload would be huge, so the shape
  // drops per-entry result/content/transform and keeps url+status+tier+code+finalUrl.
  const sc = buildBulkStructuredContent(makeBulk(50, 8_000));
  const json = JSON.stringify(sc);
  assert.ok(json.length <= 25_000, `structured length ${json.length} exceeds the ~25 KB cap`);
  const rows = sc.results as Array<{ result?: string }>;
  assert.ok(rows.every((r) => r.result === undefined), "snippets dropped on overflow");
  assert.ok(rows.every((r) => r.url !== undefined && r.status !== undefined && r.finalUrl !== undefined), "core fields retained");
});

test("bulk structured: 50 × 2048-char URLs stays ≤ 25 KB via the compact tier (clips url/finalUrl)", () => {
  // An adversarial max-URL input: even after dropping snippets, 50 × 2048-char url+finalUrl
  // rows would be ~200 KB. The compact tier clips url/finalUrl + drops heavy fields.
  const longUrl = `https://a.test/${"x".repeat(2030)}`; // ~2048 chars
  const results = Array.from({ length: 50 }, (_, i) => ({ ...makeSeed(i, 100), url: `${longUrl}${i}`, finalUrl: `${longUrl}${i}` }));
  const bulk: BulkResult = { ...makeBulk(1, 100), results, count: 50, passed: 50 };
  const sc = buildBulkStructuredContent(bulk);
  const len = JSON.stringify(sc).length;
  assert.ok(len <= 25_000, `compact tier length ${len} exceeds the 25 KB ceiling`);
  const rows = sc.results as Array<{ url: string; status: string; tier: string }>;
  assert.ok(rows.every((r) => r.url.length <= 101), "urls clipped in the compact tier");
  assert.ok(rows.every((r) => r.status !== undefined && r.tier !== undefined), "core fields retained");
});

test("bulk structured: an all-rejected bulk (200 × 2048-char invalid URLs) stays ≤ 25 KB (compact failures)", () => {
  // 200 malformed URLs (each clipped to ~2 KB at input) → 200 failure rows. The compact tier
  // caps + clips failures so the structuredContent stays bounded; the `failed` count is honest.
  const longInvalid = "x".repeat(2048);
  const failures = Array.from({ length: 200 }, (_, i) => ({ url: `${longInvalid}${i}`, code: "invalid_url", message: "URL is invalid" }));
  const bulk: BulkResult = { ...makeBulk(1, 100), results: [], count: 0, passed: 0, failed: 200, status: "fail", ok: false, failures };
  const sc = buildBulkStructuredContent(bulk);
  assert.ok(JSON.stringify(sc).length <= 25_000, `compact-failures length ${JSON.stringify(sc).length} exceeds the 25 KB ceiling`);
  assert.equal(sc.failed, 200, "the true total is reported even when failure rows are capped");
  assert.ok((sc.failures as unknown[]).length <= 30, "failure rows capped in the compact tier");
});

test("bulk text: long URLs are clipped in section headers (50 × 2048-char URLs stays ≤ 50 KB)", () => {
  // Without header clipping, 50 × 2048-char URL section headers alone would exceed the 50 KB
  // text cap, forcing the final slice to drop sections + the summary tail.
  const longUrl = `https://a.test/${"x".repeat(2030)}`;
  const results = Array.from({ length: 50 }, (_, i) => ({ ...makeSeed(i, 100), url: `${longUrl}${i}`, finalUrl: `${longUrl}${i}` }));
  const bulk: BulkResult = { ...makeBulk(1, 100), results, count: 50, passed: 50 };
  const text = bulkResultToMcpText(bulk);
  assert.ok(text.length <= 50_000, `text length ${text.length} exceeds the 50 KB cap`);
  assert.ok(!text.includes("x".repeat(500)), "long URLs clipped in the section headers");
  assert.match(text, /summary \(fence=/, "the summary tail survives (not sliced off)");
});

test("bulk text: signed query params are redacted in section headers (no presigned-signature leak)", () => {
  const seed = { ...makeSeed(0, 50), url: "https://bucket.s3.amazonaws.com/file?X-Amz-Signature=SECRET123&X-Amz-Expires=3600", finalUrl: "https://bucket.s3.amazonaws.com/file?X-Amz-Signature=SECRET123" };
  const bulk: BulkResult = { ...makeBulk(1, 50), results: [seed], count: 1, passed: 1 };
  assert.ok(!bulkResultToMcpText(bulk).includes("SECRET123"), "the presigned signature value is not in the text channel");
});

test("bulk structured: signed query params are redacted in the rows (no presigned-signature leak)", () => {
  const seed = { ...makeSeed(0, 50), url: "https://bucket.s3.amazonaws.com/file?X-Amz-Signature=SECRET123", finalUrl: "https://bucket.s3.amazonaws.com/file?X-Amz-Signature=SECRET123" };
  const bulk: BulkResult = { ...makeBulk(1, 50), results: [seed], count: 1, passed: 1 };
  assert.ok(!JSON.stringify(buildBulkStructuredContent(bulk)).includes("SECRET123"), "the presigned signature value is not in structuredContent");
});

test("bulk structured: signed query params are redacted in FAILURE rows too (failed/rejected presigned seeds)", () => {
  const failures = [{ url: "https://bucket.s3.amazonaws.com/file?X-Amz-Signature=SECRET123", code: "fetch_error", message: "fail" }];
  const bulk: BulkResult = { ...makeBulk(0, 50), results: [], count: 0, passed: 0, failed: 1, status: "fail", ok: false, failures };
  assert.ok(!JSON.stringify(buildBulkStructuredContent(bulk)).includes("SECRET123"), "presigned signature redacted from failure rows");
});

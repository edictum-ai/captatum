import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptatumInputError, normalizeBulkInput } from "../src/application/use-cases/bulk-input.ts";

test("normalizeBulkInput: defaults output=raw, allowRender=false, timeoutMs=8000", () => {
  const out = normalizeBulkInput({ urls: ["https://a.test/x"] });
  assert.equal(out.request.requestedOutput, "raw");
  assert.equal(out.request.allowRender, false);
  assert.equal(out.request.timeoutMs, 8000);
  assert.equal(out.seeds.length, 1);
  assert.equal(out.seeds[0].url, "https://a.test/x");
  assert.deepEqual(out.invalid, []);
});

test("normalizeBulkInput: rejects allowRender:true whole-call as bulk_render_not_supported", () => {
  assert.throws(
    () => normalizeBulkInput({ urls: ["https://a.test/x"], allowRender: true }),
    (e: unknown) => e instanceof CaptatumInputError && e.body.error.code === "bulk_render_not_supported",
  );
});

test("normalizeBulkInput: http→https upgrade + per-entry normalizeContractUrl", () => {
  const out = normalizeBulkInput({ urls: ["http://a.test/x", "HTTPS://B.TEST/Y"] });
  assert.deepEqual(out.seeds.map((s) => s.url), ["https://a.test/x", "https://b.test/Y"]);
});

test("normalizeBulkInput: per-entry bad URLs are collected, not thrown (partial is normal)", () => {
  const out = normalizeBulkInput({
    urls: [
      "https://good.test/a",
      "not a url",
      "ftp://scheme.test/x", // unsupported scheme
      "https://user:pass@userinfo.test/x", // userinfo rejected
      "https://good.test/b",
    ],
  });
  assert.deepEqual(out.seeds.map((s) => s.url), ["https://good.test/a", "https://good.test/b"]);
  assert.equal(out.invalid.length, 3);
  assert.deepEqual(out.invalid.map((i) => i.code), ["invalid_url", "unsupported_scheme", "userinfo_url"]);
});

test("normalizeBulkInput: missing urls → invalid_input whole-call error", () => {
  assert.throws(
    () => normalizeBulkInput({ prompt: "x" }),
    (e: unknown) => e instanceof CaptatumInputError && e.body.error.code === "invalid_input",
  );
});

test("normalizeBulkInput: empty urls array → invalid_input whole-call error", () => {
  assert.throws(
    () => normalizeBulkInput({ urls: [] }),
    (e: unknown) => e instanceof CaptatumInputError && e.body.error.code === "invalid_input",
  );
});

test("normalizeBulkInput: strict — unknown field → invalid_input", () => {
  assert.throws(
    () => normalizeBulkInput({ urls: ["https://a.test/x"], depth: 3 }),
    (e: unknown) => e instanceof CaptatumInputError && e.body.error.code === "invalid_input",
  );
});

test("normalizeBulkInput: caller cost knobs pass through (resolveBulkGuard clamps)", () => {
  const out = normalizeBulkInput({ urls: ["https://a.test/x"], maxTransformCostUsd: 0.1, perSeedTransformCostUsd: 0.02 });
  assert.equal(out.request.maxTransformCostUsd, 0.1);
  assert.equal(out.request.perSeedTransformCostUsd, 0.02);
});

test("normalizeBulkInput: all-invalid URLs → empty seeds (0-count result, not a tool error)", () => {
  const out = normalizeBulkInput({ urls: ["bad", "alsobad"] });
  assert.equal(out.seeds.length, 0);
  assert.equal(out.invalid.length, 2);
});

test("normalizeBulkInput: a URL over 2048 chars → per-entry url_too_long (bounds the delivery ceilings)", () => {
  const long = "https://a.test/" + "x".repeat(2100);
  const out = normalizeBulkInput({ urls: ["https://good.test/x", long] });
  assert.equal(out.seeds.length, 1);
  assert.equal(out.invalid.length, 1);
  assert.equal(out.invalid[0].code, "url_too_long");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseClientProfileMap,
  resolveClientProfile,
  DEFAULT_CLIENT_PROFILE,
} from "../src/application/client-profile.ts";
import { resultToMcpText, debugTextBlock } from "../src/interfaces/mcp/format.ts";
import type { Result } from "../src/domain/result.ts";

// ---------- profile resolver + config parsing ----------

test("parseClientProfileMap maps clientId→profile and ignores junk", () => {
  const map = parseClientProfileMap("claude-id=text-forward,chatgpt-id=default, junk , bad=nonexistent, =x");
  assert.equal(map.get("claude-id"), "text-forward");
  assert.equal(map.get("chatgpt-id"), "default");
  assert.equal(map.has("junk"), false); // no '=' → ignored
  assert.equal(map.has("bad"), false); // unknown profile name → ignored (fail-safe)
  assert.equal(map.size, 2);
});

test("resolveClientProfile: known clientId → its profile; unknown/local → default", () => {
  const map = parseClientProfileMap("claude-id=text-forward");
  assert.equal(resolveClientProfile("claude-id", map).textDebug, true);
  // unknown clientId + absent clientId + empty map all fall back to default (no behavior change)
  assert.equal(resolveClientProfile("chatgpt-id", map).textDebug, false);
  assert.equal(resolveClientProfile(undefined, map).textDebug, false);
  assert.equal(resolveClientProfile("claude-id", parseClientProfileMap("")).textDebug, false);
  assert.deepEqual(resolveClientProfile("any", parseClientProfileMap(undefined)), DEFAULT_CLIENT_PROFILE);
});

// ---------- debug-in-text (#45) ----------

function summaryResult(over: Partial<Result> = {}): Result {
  return {
    url: "https://example.test/", bytes: 100, code: 200, codeText: "OK", durationMs: 50,
    result: "A concise summary.", schemaVersion: 1, finalUrl: "https://example.test/", redirects: [],
    tier: 1, output: "summary",
    platform: { adapterId: "generic", label: "Generic HTML", detectedFrom: "tier1" },
    jsRequired: false, resolvedVia: "tier1-meta",
    attempts: [{ step: 1, tier: 1, outcome: "ok", status: 200, durationMs: 40, bytes: 100, reason: "content-present" }],
    contentType: "text/html; charset=utf-8", timings: { totalMs: 50, fetchMs: 40, transformMs: 10 }, errors: [],
    transform: { provider: "openrouter", model: "x-model", free: true, inTokens: 100, outTokens: 20 },
    ...over,
  } as Result;
}

test("resultToMcpText provenance carries truncated= for a mid-read transport truncation, every output mode (#149)", () => {
  // The provenance comment is the most reliable model-visible channel — present for EVERY output
  // mode incl. raw (where there is no envelope header). A text-forward client that renders only
  // content[0].text must see the content is incomplete. Teeth-check: without the format fix the
  // comment has no truncated field, so partial transport-unreliable bytes arrive with no signal.
  const transportErr = [{ code: "body_read_error", message: "Response body truncated mid-read (transport error) — partial content returned, may be incomplete" }];
  assert.match(resultToMcpText(summaryResult({ errors: transportErr }), false), /truncated=body_read_error/);
  // A cap truncation is labelled distinctly (clean prefix, not transport).
  assert.match(resultToMcpText(summaryResult({ errors: [{ code: "max_bytes", message: "Content truncated at the byte cap" }] }), false), /truncated=max_bytes/);
  // No truncation → no truncated field (byte-identical provenance; the raw contract fixtures stay stable).
  assert.doesNotMatch(resultToMcpText(summaryResult(), false), /truncated=/);
  // Raw output ALSO carries it — the raw path has no envelope header, so this is the ONLY signal.
  assert.match(resultToMcpText(summaryResult({ output: "raw", result: "<html>partial</html>", errors: transportErr }), false), /truncated=body_read_error/);
  // #149 codex P1: a raw JSON body normally omits the comment (stays parseable JSON), but a TRUNCATED
  // raw JSON body is partial/unparseable anyway, so the comment (with truncated=) is prepended — the
  // text-forward client still sees the signal. A clean raw JSON body stays comment-free (parseable).
  assert.equal(resultToMcpText(summaryResult({ output: "raw", contentType: "application/json", result: '{"jobs":[]}', errors: [] }), false), '{"jobs":[]}', "clean raw JSON stays parseable (no comment)");
  assert.match(resultToMcpText(summaryResult({ output: "raw", contentType: "application/json", result: '{"jobs":[1,2', errors: transportErr }), false), /^<!-- captatum .*truncated=body_read_error/, "truncated raw JSON prepends the provenance comment");
});

test("resultToMcpText with textDebug appends a diagnostics block for non-raw output", () => {
  const text = resultToMcpText(summaryResult(), true);
  assert.match(text, /--- debug ---/);
  assert.match(text, /tier: 1/);
  assert.match(text, /attempt 1: tier 1 ok 200/);
  assert.match(text, /transform: openrouter x-model.*in=100.*out=20/);
  // without textDebug, no debug block
  assert.doesNotMatch(resultToMcpText(summaryResult(), false), /--- debug ---/);
});

test("debugTextBlock caps attempts so many blocked sub-resources can't flood the text", () => {
  const attempts = Array.from({ length: 60 }, (_, n) => ({
    step: n + 1, tier: 3 as const, outcome: "blocked" as const, durationMs: 1, bytes: 0, reason: "ad-tracker",
  }));
  attempts[59] = { step: 60, tier: 3, outcome: "rejected", durationMs: 5, bytes: 0, reason: "render-timeout" };
  const block = debugTextBlock(summaryResult({ attempts }));
  const lines = block.split("\n").filter((l) => l.startsWith("attempt "));
  assert.equal(lines.length, 50, "only 50 attempt lines emitted (49 head + 1 terminal)");
  assert.match(block, /\(\+10 more attempts not shown\)/);
  // The terminal (failure) attempt is preserved even though it's past the cap.
  assert.match(lines[49], /attempt 60: tier 3 rejected.*render-timeout/);
});

test("debug-in-text never applies to raw output (the caller asked for clean content)", () => {
  const raw = summaryResult({ output: "raw", result: "<html>clean</html>", contentType: "text/html; charset=utf-8" });
  assert.doesNotMatch(resultToMcpText(raw, true), /--- debug ---/);
  // raw JSON stays parseable (no provenance comment, no debug block)
  const rawJson = summaryResult({ output: "raw", result: '{"jobs":[]}', contentType: "application/json" });
  assert.equal(resultToMcpText(rawJson, true), '{"jobs":[]}');
});

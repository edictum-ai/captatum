import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertAllowedRedirectUri,
  DEFAULT_ALLOWED_REDIRECT_ORIGINS,
} from "../src/application/use-cases/oauth-authorization.ts";
import { OAuthError } from "../src/application/use-cases/oauth-errors.ts";

function allow(uri: string, list: string[] = []) {
  try {
    return { ok: true as const, value: assertAllowedRedirectUri(uri, list) };
  } catch (e) {
    return { ok: false as const, code: e instanceof OAuthError ? e.code : "throw" };
  }
}

test("DEFAULT_ALLOWED_REDIRECT_ORIGINS covers Claude/ChatGPT/native", () => {
  assert.deepEqual([...DEFAULT_ALLOWED_REDIRECT_ORIGINS], [
    "https://claude.ai",
    "https://chatgpt.com",
    "http://localhost",
    "http://127.0.0.1",
  ]);
});

test("defaults: web MCP-client origins accepted on any callback path", () => {
  // ChatGPT generates a unique per-connector path under its origin
  assert.equal(allow("https://chatgpt.com/connector_platform_oauth_abc-123").ok, true);
  assert.equal(allow("https://claude.ai/api/mcp/auth/callback").ok, true);
});

test("defaults: native loopback accepted on ANY port (RFC 8252 §7.3)", () => {
  for (const port of [29352, 40128, 8080, 1, 65535]) {
    assert.equal(allow(`http://localhost:${port}/callback`).ok, true, `localhost:${port}`);
    assert.equal(allow(`http://127.0.0.1:${port}/callback`).ok, true, `127.0.0.1:${port}`);
  }
});

test("an explicit-port loopback entry is NOT widened to any port", () => {
  // [::1] is not a default origin, so this isolates the entry's behavior. new URL
  // drops default ports (http://[::1]:80 → port ""), so the RAW entry is checked for
  // an explicit port before applying any-port loopback matching.
  assert.equal(allow("http://[::1]:9999/cb", ["http://[::1]:80"]).ok, false);
  // …but a portless loopback entry still widens (regression guard; localhost is a default):
  assert.equal(allow("http://localhost:9999/cb", ["http://localhost"]).ok, true);
  assert.equal(allow("http://[::1]:9999/cb", ["http://[::1]"]).ok, true);
});

test("env allowlist ADDS origins; it cannot remove a default", () => {
  assert.equal(allow("https://my-app.com/oauth/callback", ["https://my-app.com"]).ok, true);
  // defaults remain in effect alongside a custom list
  assert.equal(allow("https://chatgpt.com/x", ["https://my-app.com"]).ok, true);
  assert.equal(allow("http://localhost:9999/cb", ["https://my-app.com"]).ok, true);
});

test("security: disallowed origins + lookalikes + userinfo rejected", () => {
  assert.equal(allow("https://evil.com/callback").ok, false);
  assert.equal(allow("https://chatgpt.com.evil.com/cb").ok, false); // lookalike host, not chatgpt.com
  assert.equal(allow("https://evil.com/cb", ["*"]).ok, false); // "*" is NOT allow-all
  assert.equal(allow("https://user:pass@chatgpt.com/cb").ok, false); // userinfo rejected
  // https loopback is NOT matched by the http://localhost default (add https://localhost if wanted)
  assert.equal(allow("https://localhost:443/cb").ok, false);
});

test("a path-specific loopback entry is NOT widened to any port (only origin entries widen)", () => {
  // [::1] is not a default, so this isolates the entry's behavior. Entry carries a path (/callback)
  // → exact-match intent, NOT an any-port loopback origin → a different port/path is rejected.
  assert.equal(allow("http://[::1]:9999/other", ["http://[::1]/callback"]).ok, false);
  // a query-bearing entry is also exact-match intent (not widened):
  assert.equal(allow("http://[::1]:9999/any", ["http://[::1]/?cb=foo"]).ok, false);
  // an ORIGIN loopback entry (no path, no query) DOES widen to any port:
  assert.equal(allow("http://[::1]:9999/any", ["http://[::1]"]).ok, true);
});

test("localhost cannot be restricted to a port/path — the default http://localhost always applies", () => {
  // The env allowlist only ADDS; the built-in http://localhost (any port) can't be removed, so
  // adding a path-specific localhost entry does NOT narrow native redirects.
  assert.equal(allow("http://localhost:7/cb", ["http://localhost/exact"]).ok, true);
});

test("IPv6 loopback ([::1]) matches any port when allowlisted as an origin", () => {
  assert.equal(allow("http://[::1]:49152/callback", ["http://[::1]"]).ok, true);
  assert.equal(allow("http://[::1]:8/cb").ok, false); // not a default; must be allowlisted
});

test("exact-match entry still works and returns the normalized URI", () => {
  const r = allow("https://my-app.com/exact-cb", ["https://my-app.com/exact-cb"]);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.value, "https://my-app.com/exact-cb");
});

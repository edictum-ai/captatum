import assert from "node:assert/strict";
import { test } from "node:test";
import { emailAllowed, validateClaims } from "../src/infrastructure/auth/cloudflare-access-jwt.ts";
import type { CloudflareAccessJwtConfig } from "../src/infrastructure/auth/cloudflare-access-jwt.ts";

const cfg = (emailAllowlist?: string[]): CloudflareAccessJwtConfig => ({
  audience: "aud",
  certsUrl: "https://x/certs",
  issuer: "https://x",
  ...(emailAllowlist ? { emailAllowlist } : {}),
});

test("validateClaims delegates to Zero Trust when no allowlist is set (any non-empty email)", () => {
  assert.equal(validateClaims({ email: "any@x.test", exp: 123 }, cfg()).ok, true);
  assert.equal(validateClaims({ email: "any@x.test", exp: 123 }, cfg([])).ok, true, "empty array = delegate");
});

test("validateClaims rejects an out-of-allowlist email", () => {
  const r = validateClaims({ email: "b@x.test", exp: 123 }, cfg(["a@x.test"]));
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, "access_jwt_email_not_allowed");
});

test("validateClaims accepts an in-allowlist email (case-insensitive)", () => {
  assert.equal(validateClaims({ email: "Agent@X.test", exp: 123 }, cfg(["agent@x.test"])).ok, true);
});

test("validateClaims rejects a missing email claim regardless of allowlist", () => {
  assert.equal(validateClaims({ exp: 123 }, cfg()).ok, false);
  assert.equal(validateClaims({ exp: 123 }, cfg(["a@x.test"])).ok, false);
});

// #9: the CF Access JWT verifier delegates the email allowlist to the Cloudflare Zero
// Trust app policy by default. CF_ACCESS_EMAIL_ALLOWLIST adds a defense-in-depth
// second gate; emailAllowed is its pure, network-free core (the verifier itself hits
// JWKS, so it is not driven here).

test("emailAllowed matches case-insensitively and ignores surrounding whitespace", () => {
  assert.equal(emailAllowed("agent@x.test", ["Agent@X.TEST"]), true);
  assert.equal(emailAllowed(" agent@x.test ", ["agent@x.test"]), true);
  assert.equal(emailAllowed("b@x.test", ["agent@x.test"]), false);
});

test("emailAllowed rejects an empty/blank email", () => {
  assert.equal(emailAllowed("", ["agent@x.test"]), false);
  assert.equal(emailAllowed("   ", ["agent@x.test"]), false);
});

test("emailAllowed ignores empty allowlist entries from trailing commas", () => {
  // envList drops empties, but the helper must not let a stray "" match anything.
  assert.equal(emailAllowed("any@x.test", [""]), false);
  assert.equal(emailAllowed("any@x.test", ["agent@x.test", ""]), false);
  assert.equal(emailAllowed("agent@x.test", ["agent@x.test", ""]), true);
});

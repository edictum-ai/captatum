import assert from "node:assert/strict";
import { test } from "node:test";
import { OAuthError, bearerChallenge } from "../src/application/use-cases/oauth-errors.ts";

// #104: a non-OAuth Streamable HTTP client must read WHY its /mcp request was
// rejected from the WWW-Authenticate challenge. RFC 6750 §3 governs the shape.

test("bearerChallenge emits error + error_description for an RFC 6750 invalid_token", () => {
  const challenge = bearerChallenge(new OAuthError("invalid_token", "token missing", 401));
  assert.equal(challenge, 'Bearer realm="captatum", error="invalid_token", error_description="token missing"');
});

test("bearerChallenge emits error + error_description for insufficient_scope", () => {
  const challenge = bearerChallenge(new OAuthError("insufficient_scope", "need fetch:transform", 403));
  assert.match(challenge, /error="insufficient_scope"/);
  assert.match(challenge, /error_description="need fetch:transform"/);
});

test("bearerChallenge stays conformant (realm only) for a non-RFC-6750 code", () => {
  // access_denied is an RFC 6749 value (authorization endpoint), not a bearer
  // resource value — emitting it as `error` would be non-conformant, so the
  // challenge must carry realm only (no error / error_description).
  const challenge = bearerChallenge(new OAuthError("access_denied", "cf access missing", 401));
  assert.equal(challenge, 'Bearer realm="captatum"');
  assert.doesNotMatch(challenge, /error=/);
});

test("bearerChallenge constrains error_description to the RFC 6750 / HTTP-header ASCII charset", () => {
  // error_description MUST be %x20-21 / %x23-5B / %x5D-7E (no DQUOTE 0x22, no
  // backslash 0x5C). Non-ASCII would also break the HTTP header (Node ERR_INVALID_CHAR).
  // Defensive — our messages stay ASCII, but a future message must not break the header.
  const challenge = bearerChallenge(new OAuthError("invalid_token", 'a "quoted" and \\backslashed message', 401));
  const desc = challenge.match(/error_description="([^"]*)"/)?.[1] ?? "";
  assert.ok(!desc.includes('"'), "no DQUOTE inside the error_description value");
  assert.ok(!desc.includes("\\"), "no backslash inside the error_description value");
  assert.equal(desc, "a -quoted- and -backslashed message");
});

test("bearerChallenge strips a non-ASCII em dash from the header (ERR_INVALID_CHAR regression)", () => {
  // The real token-required message contains an em dash (U+2014). Node rejects
  // non-ASCII bytes in an HTTP header value, so the header value must be ASCII even
  // though the JSON-RPC message keeps the em dash.
  const msg = "OAuth Bearer access token required — obtain one via /oauth/token";
  const challenge = bearerChallenge(new OAuthError("invalid_token", msg, 401));
  const desc = challenge.match(/error_description="([^"]*)"/)?.[1] ?? "";
  assert.ok(/^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/.test(desc), "error_description is RFC-6750 ASCII");
  assert.ok(!desc.includes("—"), "em dash stripped from the header value");
  assert.ok(desc.includes("/oauth/token"), "the actionable remedy survives");
});

test("bearerChallenge omits error_description when the message is empty", () => {
  const challenge = bearerChallenge(new OAuthError("invalid_token", "", 401));
  assert.equal(challenge, 'Bearer realm="captatum", error="invalid_token"');
});

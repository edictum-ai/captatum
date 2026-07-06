import assert from "node:assert/strict";
import { test } from "node:test";
import { OAuthError, bearerChallenge } from "../src/application/use-cases/oauth-errors.ts";

// #104: a non-OAuth Streamable HTTP client must read WHY its /mcp request was
// rejected. RFC 6750 §3 governs the WWW-Authenticate challenge shape, including:
// the `error` attribute MUST NOT appear when the request lacks authentication info.

test("bearerChallenge emits error + error_description for an invalid_token that was presented", () => {
  // A Bearer token was sent and failed verification — credentials presented.
  const challenge = bearerChallenge(new OAuthError("invalid_token", "token rejected", 401, true));
  assert.equal(challenge, 'Bearer realm="captatum", error="invalid_token", error_description="token rejected"');
});

test("bearerChallenge stays realm-only when credentials are ABSENT (RFC 6750 §3)", () => {
  // No Authorization header / non-Bearer scheme → invalid_token but NOT presented.
  // RFC 6750 §3: "The resource server SHOULD NOT include the 'error' attribute if
  // the request lacks any authentication information." The actionable remedy still
  // reaches the client via the JSON-RPC body; the header is realm-only. (#104 codex P2)
  const challenge = bearerChallenge(new OAuthError("invalid_token", "token required", 401));
  assert.equal(challenge, 'Bearer realm="captatum"');
  assert.doesNotMatch(challenge, /error=/);
});

test("bearerChallenge emits error + error_description for insufficient_scope (presented)", () => {
  // A verified token reached the scope check — credentials presented.
  const challenge = bearerChallenge(new OAuthError("insufficient_scope", "need fetch:transform", 403, true));
  assert.match(challenge, /error="insufficient_scope"/);
  assert.match(challenge, /error_description="need fetch:transform"/);
});

test("bearerChallenge stays conformant (realm only) for a non-RFC-6750 code, even if presented", () => {
  // access_denied is an RFC 6749 value (authorization endpoint), not a bearer
  // resource value — emitting it as `error` would be non-conformant, so the
  // challenge must carry realm only regardless of whether credentials were presented.
  const challenge = bearerChallenge(new OAuthError("access_denied", "cf access missing", 401, true));
  assert.equal(challenge, 'Bearer realm="captatum"');
  assert.doesNotMatch(challenge, /error=/);
});

test("bearerChallenge constrains error_description to the RFC 6750 / HTTP-header ASCII charset", () => {
  // error_description MUST be %x20-21 / %x23-5B / %x5D-7E (no DQUOTE 0x22, no
  // backslash 0x5C). Non-ASCII would also break the HTTP header (Node ERR_INVALID_CHAR).
  // Defensive — our messages stay ASCII, but a future message must not break the header.
  const challenge = bearerChallenge(new OAuthError("invalid_token", 'a "quoted" and \\backslashed message', 401, true));
  const desc = challenge.match(/error_description="([^"]*)"/)?.[1] ?? "";
  assert.ok(!desc.includes('"'), "no DQUOTE inside the error_description value");
  assert.ok(!desc.includes("\\"), "no backslash inside the error_description value");
  assert.equal(desc, "a -quoted- and -backslashed message");
});

test("bearerChallenge strips a non-ASCII em dash from the header (ERR_INVALID_CHAR regression)", () => {
  // A message with an em dash (U+2014). Node rejects non-ASCII bytes in an HTTP
  // header value, so the header value must be ASCII even though the JSON-RPC body
  // keeps the em dash. (presented so error_description is emitted at all.)
  const msg = "OAuth Bearer access token required — obtain one via /oauth/token";
  const challenge = bearerChallenge(new OAuthError("invalid_token", msg, 401, true));
  const desc = challenge.match(/error_description="([^"]*)"/)?.[1] ?? "";
  assert.ok(/^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/.test(desc), "error_description is RFC-6750 ASCII");
  assert.ok(!desc.includes("—"), "em dash stripped from the header value");
  assert.ok(desc.includes("/oauth/token"), "the actionable remedy survives");
});

test("bearerChallenge omits error_description when the message is empty (but still emits error)", () => {
  const challenge = bearerChallenge(new OAuthError("invalid_token", "", 401, true));
  assert.equal(challenge, 'Bearer realm="captatum", error="invalid_token"');
});

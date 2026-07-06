export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
  }
}

export function oauthErrorBody(error: OAuthError): { error: { code: string; message: string } } {
  return { error: { code: error.code, message: error.message } };
}

// RFC 6750 §3.1 values that are valid as a Bearer challenge's `error` attribute.
// Other OAuthError codes (access_denied, invalid_grant, …) are RFC 6749 values used
// at the /oauth/* authorization/token endpoints, not bearer-resource values, so a
// challenge for them stays realm-only to remain conformant. (#104)
const RFC6750_BEARER_ERRORS = new Set(["invalid_request", "invalid_token", "insufficient_scope"]);

/**
 * Build a `WWW-Authenticate: Bearer …` challenge (RFC 6750 §3). A non-OAuth
 * Streamable HTTP client — one that POSTs a JSON-RPC body to /mcp without running
 * the OAuth flow — gets `error` + `error_description` so it can tell
 * PROGRAMMATICALLY why its request was rejected. A bare `Bearer` leaves such a
 * client guessing; the `error_description` also carries the actionable text a human
 * reads in the JSON-RPC `message`, so both channels agree. (#104)
 *
 * `error` is emitted only for RFC-6750-§3.1 values; other codes emit realm only.
 */
export function bearerChallenge(error: OAuthError): string {
  const parts = ['Bearer realm="captatum"'];
  if (RFC6750_BEARER_ERRORS.has(error.code)) {
    parts.push(`error="${error.code}"`);
    if (error.message) parts.push(`error_description="${escapeBearerAttr(error.message)}"`);
  }
  return parts.join(", ");
}

// RFC 6750 §3 restricts error_description to %x20-21 / %x23-5B / %x5D-7E (ASCII,
// excluding DQUOTE 0x22 and backslash 0x5C). Anything else — including non-ASCII
// (an em dash) which Node also rejects in an HTTP header value (ERR_INVALID_CHAR) —
// is replaced with a hyphen so a future message can never break the header. The
// JSON-RPC `message` keeps the original text; only the header value is constrained.
function escapeBearerAttr(value: string): string {
  let out = "";
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    out += (c >= 0x20 && c <= 0x21) || (c >= 0x23 && c <= 0x5b) || (c >= 0x5d && c <= 0x7e) ? ch : "-";
  }
  return out;
}

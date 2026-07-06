export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;
  /**
   * True when the client actually presented credentials that were processed and
   * rejected (a Bearer token that failed verification, or a verified token that
   * failed a scope check). False when the request lacked authentication
   * information (no Authorization header, or a non-Bearer scheme). Gates the
   * `error` attribute in the RFC 6750 challenge — see bearerChallenge. (#104)
   */
  readonly presented: boolean;

  constructor(code: string, message: string, status = 400, presented = false) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
    this.presented = presented;
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
 * RFC 6750 §3: "The resource server SHOULD NOT include the 'error' attribute if the
 * request lacks any authentication information." So `error`/`error_description` are
 * emitted only when the client actually presented credentials that were rejected
 * (`error.presented`: a Bearer token that failed verification, or a verified token
 * that failed a scope check) AND the code is an RFC-6750-§3.1 value. A no-credentials
 * `invalid_token` (no Authorization header, or a non-Bearer scheme) stays realm-only
 * — the actionable remedy still reaches the client via the JSON-RPC body.
 */
export function bearerChallenge(error: OAuthError): string {
  const parts = ['Bearer realm="captatum"'];
  if (RFC6750_BEARER_ERRORS.has(error.code) && error.presented) {
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

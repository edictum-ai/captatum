import { isLoopbackHost, isPrivate } from "../../domain/policy.ts";

/** Query-param keys whose presence on a URL means the URL itself carries a real credential —
 *  checked on BOTH the source url AND any url embedded in fetched content. NOT ad-tracker noise:
 *  a presigned cloud URL or an OAuth bearer link egressed to a hosted LLM is a real secret leak.
 *  AWS/GCS presigned signatures, Azure Blob SAS (sig), JWS (signature), Tencent COS (q-signature),
 *  OAuth bearer (access_token) and API-key (api_key) tokens. */
export const CONTENT_CREDENTIAL_QUERY_KEYS = new Set([
  "x-amz-credential", "x-amz-signature", "x-amz-security-token", "x-goog-signature",
  "sig", "signature", "q-signature", "access_token", "api_key",
]);

/** Adds the generic keys ad/CDN trackers abuse (token/key/auth/expires) for the SOURCE-url check
 *  ONLY. Fetching a url that carries one is suspicious; a public page that merely LINKS one is not
 *  (the #44 false-positive class — content-embedded ad/CDN noise, not credentials). */
export const SIGNED_QUERY_KEYS = new Set([
  ...CONTENT_CREDENTIAL_QUERY_KEYS, "token", "key", "auth", "expires",
]);

const INTERNAL_HOST_SUFFIXES = [
  ".local", ".internal", ".corp", ".intranet", ".localhost", ".priv",
  ...(process.env.INTERNAL_HOST_SUFFIXES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
];

/** Strip an RFC 6874 zone id from a bracketed IPv6 host so new URL() doesn't throw on it (Node's
 *  URL parser rejects [fe80::1%eth0] and the percent-encoded [fe80::1%25eth0]). Applied at the top
 *  of every helper that calls new URL() on a possibly-IPv6 source url. */
function withoutZone(sourceUrl: string): string {
  return sourceUrl.replace(/\[([^\]]*?)%[0-9a-zA-Z_-]+\]/, "[$1]");
}

/** Loopback (localhost, .localhost, 127.0.0.0/8, ::1 incl. bracketed [::1]) — a docs/example target
 *  that resolves to the reader's own machine, not a leaked internal endpoint. Exempt from the
 *  CONTENT-embedded scan (allowLoopback); kept on the SOURCE-url scan. Reuses domain/policy's
 *  isLoopbackHost (bracket/zone stripping) so IPv6 loopback classifies correctly. */
export function isLoopback(host: string): boolean {
  return isLoopbackHost(host) || host.endsWith(".localhost");
}

/** Host-agnostic query-credential check: extracts the query substring directly (between '?' and the
 *  next '#' / end), so a malformed or zone-id host that makes new URL() throw cannot defeat it. A
 *  bare ?key with no value (a docs anchor / template) is NOT a credential — require a non-empty
 *  value. HTML-escaped separators (&amp;/&#38;/&#x26;) normalized first. */
export function signedUrlReason(sourceUrl: string, keys: Set<string> = SIGNED_QUERY_KEYS): string | undefined {
  const q = sourceUrl.replace(/&(amp|#38|#x26);/gi, "&");
  const queryStart = q.indexOf("?");
  if (queryStart === -1) return undefined;
  const hashAfter = q.indexOf("#", queryStart);
  const query = hashAfter === -1 ? q.slice(queryStart + 1) : q.slice(queryStart + 1, hashAfter);
  for (const [key, value] of new URLSearchParams(query).entries()) {
    if (value && keys.has(key.toLowerCase())) return "signed_or_tokenized_url";
  }
  return undefined;
}

/** A credential key in the URL FRAGMENT with a non-empty value (#access_token=…). signedUrlReason
 *  only checks query params, so without this a tokenized fragment (e.g. a loopback OAuth redirect)
 *  would egress. A bare anchor (#access_token, a docs TOC link) carries no value — not flagged.
 *  HTML-escaped separators normalized the same way. */
export function fragmentCredentialReason(sourceUrl: string, keys: Set<string>): string | undefined {
  const hash = sourceUrl.indexOf("#");
  if (hash === -1) return undefined;
  const fragment = sourceUrl.slice(hash + 1).replace(/&(amp|#38|#x26);/gi, "&");
  for (const [key, value] of new URLSearchParams(fragment).entries()) {
    if (value && keys.has(key.toLowerCase())) return "signed_or_tokenized_url";
  }
  return undefined;
}

/** A basic-auth PASSWORD in the URL USERINFO (user:pass@host). A username-only userinfo (git clone
 *  https://octocat@host/…) is an identifier, not a secret — not flagged (real API keys placed in the
 *  username slot are caught by the credential-value patterns in safety.ts). Zone-id hosts normalized. */
export function userinfoCredentialReason(sourceUrl: string): string | undefined {
  try {
    const parsed = new URL(withoutZone(sourceUrl));
    if (parsed.password) return "userinfo_credential";
  } catch { /* ignore unparseable URLs */ }
  return undefined;
}

/** OAuth authorization-code / refresh-token (with a value) on a LOOPBACK url. code/refresh_token
 *  are too generic to flag on every content URL (coupon ?code=SAVE20), but on a loopback redirect
 *  they ARE credentials (captatum's own OAuth uses loopback redirects). Checked in query AND
 *  fragment (implicit flow). Zone-id hosts normalized. */
export function loopbackOAuthCredentialReason(sourceUrl: string): string | undefined {
  const flow = new Set(["code", "refresh_token"]);
  try {
    // Normalize HTML-escaped separators BEFORE parsing, else '&amp;code=' parses as 'amp;code'
    // (the same normalization signedUrlReason/fragmentCredentialReason apply). Zone-id normalized too.
    const parsed = new URL(withoutZone(sourceUrl.replace(/&(amp|#38|#x26);/gi, "&")));
    if (!isLoopback(parsed.hostname)) return undefined;
    for (const [key, value] of parsed.searchParams.entries()) {
      if (value && flow.has(key.toLowerCase())) return "loopback_oauth_credential";
    }
    for (const [key, value] of new URLSearchParams((parsed.hash || "").slice(1)).entries()) {
      if (value && flow.has(key.toLowerCase())) return "loopback_oauth_credential";
    }
  } catch { /* ignore unparseable URLs */ }
  return undefined;
}

/** A reason if the host is internal (loopback / internal suffix / private-IP literal incl. cloud
 *  metadata 169.254.169.254). allowLoopback exempts a loopback host for the CONTENT-embedded docs
 *  example — used ONLY after the credential checks have cleared the URL. Zone-id hosts normalized. */
export function internalHostReason(sourceUrl: string, allowLoopback = false): string | undefined {
  try {
    const host = new URL(withoutZone(sourceUrl)).hostname.toLowerCase().replace(/\.$/, "");
    if (isLoopback(host)) return allowLoopback ? undefined : "internal_host";
    if (host === "localhost" || INTERNAL_HOST_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) {
      return "internal_host";
    }
    if (isPrivate(host)) return "internal_host";
  } catch { /* ignore unparseable URLs */ }
  return undefined;
}

/**
 * Detect ACTUAL leaked credential VALUES in fetched content — not topic words.
 *
 * The earlier version matched the words "secret"/"password"/"cookie"/"api_key",
 * which false-positived on any page that merely DISCUSSES security (e.g. a
 * security product's marketing page, or any page with a cookie notice). That
 * silently degraded the default summary to raw for ordinary public pages.
 *
 * Value-based detection is strictly better: it catches real leaked secrets
 * (token prefixes, PEM headers, signed URLs) without flagging discussion text.
 * Security-relevant change — reflect in docs/threat-model.md.
 */
import { isLoopbackHost, isPrivate } from "../../domain/policy.ts";

const SENSITIVE_CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/i,
  /\bgh[opsu]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[bp]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  // Cloud env-var / config-file secret assignments (the KEY NAME + a value shape,
  // NOT a generic "secret=" word match — that false-positived on pages that merely
  // discuss security). The `AKIA` regex above catches the AWS access-key id; these
  // catch its paired secret, the STS session token, and an Azure service-principal
  // secret when leaked as a `NAME=value` blob in fetched content.
  /\bAWS_SECRET_ACCESS_KEY\s*=\s*[A-Za-z0-9/+=]{40}\b/,
  /\bAWS_SESSION_TOKEN\s*=\s*[A-Za-z0-9/+=_-]{50,}\b/,
  /\bAZURE_CLIENT_SECRET\s*=\s*[A-Za-z0-9._~+/=-]{30,}\b/,
];

const SENSITIVE_HEADER_PATTERNS = [
  // HTTP headers are case-insensitive: match any case so a lower/all-caps dump
  // (`authorization: bearer …`, `AUTHORIZATION: BASIC …`) is still caught.
  /authorization:\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /set-cookie:\s*[^=\s;]{1,64}=[^;\s<]{16,}/i,
];

/** Query-param keys whose presence on a URL means the URL itself carries a real
 *  credential — checked on BOTH the source url AND any url embedded in fetched
 *  content. These are NOT ad-tracker noise: a presigned cloud URL or an OAuth
 *  bearer link egressed to a hosted LLM is a genuine secret leak.
 *  - AWS / GCS presigned-URL signing params.
 *  - Azure Blob SAS (`sig`), generic/Alibaba JWS (`signature`), Tencent COS
 *    (`q-signature`) signing signatures.
 *  - OAuth bearer (`access_token`) and API-key (`api_key`) tokens. */
const CONTENT_CREDENTIAL_QUERY_KEYS = new Set([
  "x-amz-credential",
  "x-amz-signature",
  "x-amz-security-token",
  "x-goog-signature",
  "sig",
  "signature",
  "q-signature",
  "access_token",
  "api_key",
]);

/** Adds the generic keys ad/CDN trackers abuse (`token`, `key`, `auth`, `expires`)
 *  for the SOURCE-url check ONLY. Fetching a url that carries one is suspicious
 *  (it may be a signed/tokenized fetch), so it is still flagged. But a public page
 *  that merely LINKS one (the #44 false-positive class — e.g. an estadao.com.br
 *  search template `?token={…}`) is NOT, because on content those keys are
 *  ordinary ad/CDN noise, not credentials. Real URL credentials use the keys in
 *  CONTENT_CREDENTIAL_QUERY_KEYS above. */
const SIGNED_QUERY_KEYS = new Set([
  ...CONTENT_CREDENTIAL_QUERY_KEYS,
  "token",
  "key",
  "auth",
  "expires",
]);

const INTERNAL_HOST_SUFFIXES = [
  ".local", ".internal", ".corp", ".intranet", ".localhost", ".priv",
  ...(process.env.INTERNAL_HOST_SUFFIXES ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
];

/** Bounded URL-literal scan for embedded signed/internal URLs in content. Excludes ']' so a
 *  prose bracket like "[see http://10.0.0.5]." stops cleanly at the ']' and the internal host is
 *  still scanned. (Bracketed IPv6 literals like http://[fd00::1] are NOT matched — a narrow
 *  pre-existing gap; an earlier attempt to broaden this regex to include them kept absorbing
 *  trailing prose/brackets across review rounds, so it's deferred to a focused follow-up.) */
const SIGNED_URL_IN_CONTENT = /https?:\/\/[^\s"'<>)\]]{1,512}/gi;
/** Cap the embedded-URL scan to the head of the content. The high-confidence
 *  credential/header patterns below scan the FULL content regardless of size;
 *  only the URL-embedding scan is bounded (ReDoS/DoS hygiene). A public page is
 *  never flagged solely for exceeding this cap — the residual risk is an
 *  embedded cloud-presigned URL past the cap egressing to a hosted LLM, which is
 *  accepted (see docs/threat-model.md). */
const MAX_CONTENT_SCAN = 500_000;

export interface SensitivitySignal {
  sensitive: boolean;
  reason?: string;
}

export function detectSensitiveTransformInput(input: {
  content: string;
  sourceUrl?: string;
}): SensitivitySignal {
  const urlReason = input.sourceUrl
    ? signedUrlReason(input.sourceUrl) ?? internalHostReason(input.sourceUrl)
    : undefined;
  if (urlReason) return { sensitive: true, reason: urlReason };

  // A credential VALUE in the source url (e.g. a JWT in the path) is flagged too.
  // The path-token heuristic is gone (#47), so without this a JWT present only in
  // the source url — not echoed in the body — would slip past (codex P2 on #47).
  if (input.sourceUrl) {
    for (const pattern of SENSITIVE_CREDENTIAL_PATTERNS) {
      if (pattern.test(input.sourceUrl)) return { sensitive: true, reason: "source_credential_signal" };
    }
  }

  const content = input.content ?? "";
  for (const pattern of SENSITIVE_CREDENTIAL_PATTERNS) {
    if (pattern.test(content)) return { sensitive: true, reason: "content_credential_signal" };
  }
  for (const pattern of SENSITIVE_HEADER_PATTERNS) {
    if (pattern.test(content)) return { sensitive: true, reason: "content_header_dump" };
  }
  // A public page that merely LINKS a cloud-presigned / OAuth / signed URL or an
  // internal host must not egress to a hosted LLM. Bounded scan (REDOS/DoS
  // hygiene). Only real credential keys are matched here
  // (CONTENT_CREDENTIAL_QUERY_KEYS) — not the generic ad/CDN keys (`token`/`key`/
  // `auth`/`expires`) that caused the #44 news-page false-positive regression.
  // The credential/header patterns above already scanned the FULL content.
  const head = content.length > MAX_CONTENT_SCAN ? content.slice(0, MAX_CONTENT_SCAN) : content;
  for (const match of head.matchAll(SIGNED_URL_IN_CONTENT)) {
    // allowLoopback: a public page that LINKS http://localhost:PORT (a docs/setup example —
    // resolves to the READER's machine, not a leaked internal endpoint) must not be flagged.
    // RFC1918 / 169.254.169.254 / .corp / .internal / signed-URL query keys are still flagged.
    // A credential key in the FRAGMENT (#access_token=…) is checked BEFORE the loopback exemption
    // — a loopback OAuth redirect carrying a bearer token is a real leak, not a docs example.
    const reason = signedUrlReason(match[0], CONTENT_CREDENTIAL_QUERY_KEYS)
      ?? fragmentCredentialReason(match[0], CONTENT_CREDENTIAL_QUERY_KEYS)
      ?? userinfoCredentialReason(match[0])
      ?? internalHostReason(match[0], true);
    if (reason) return { sensitive: true, reason: `content_embedded_${reason}` };
  }
  return { sensitive: false };
}

function signedUrlReason(sourceUrl: string, keys: Set<string> = SIGNED_QUERY_KEYS): string | undefined {
  let parsed: URL;
  try {
    // HTML-escaped separators (`&amp;`, `&#38;`, `&#x26;`) would prefix parsed
    // query keys with "amp;"/etc. and hide a presigned key (e.g. an embedded
    // `&amp;X-Amz-Signature=`); normalize them to `&` before parsing.
    parsed = new URL(sourceUrl.replace(/&(amp|#38|#x26);/gi, "&"));
  } catch {
    return undefined;
  }

  for (const key of parsed.searchParams.keys()) {
    if (keys.has(key.toLowerCase())) return "signed_or_tokenized_url";
  }
  // NOTE: a path-segment "opaque token" heuristic used to run here but was removed
  // (#44) — no length/alphabet rule reliably separates a real opaque token from a
  // long news-article slug (e.g. `brasil-japao-ao-vivo-copa-do-mundo-2026-06-29`)
  // or a CDN asset hash, so it caused repeated false-positives on public pages,
  // deterministically on any article with a long slug. Real path-embedded
  // credentials are still caught elsewhere: JWTs by the credential-value patterns
  // above, presigned URLs by the query-key check, internal hosts by
  // internalHostReason. See docs/threat-model.md "Sensitive-content detection".
  return undefined;
}

/** A credential key in the URL FRAGMENT (e.g. http://localhost/cb#access_token=…). signedUrlReason
 *  only checks query params, so without this a tokenized fragment on a loopback (allowLoopback) URL
 *  — or any URL — would egress to a hosted LLM. Returns "signed_or_tokenized_url" if the fragment
 *  carries a credential key. */
function fragmentCredentialReason(sourceUrl: string, keys: Set<string>): string | undefined {
  const hash = sourceUrl.indexOf("#");
  if (hash === -1) return undefined;
  // Normalize HTML-escaped separators (&amp; / &#38; / &#x26;) the same way signedUrlReason
  // does for query strings, else `#state=x&amp;access_token=…` parses as `amp;access_token`.
  const fragment = sourceUrl.slice(hash + 1).replace(/&(amp|#38|#x26);/gi, "&");
  for (const key of new URLSearchParams(fragment).keys()) {
    if (keys.has(key.toLowerCase())) return "signed_or_tokenized_url";
  }
  return undefined;
}

/** Credentials in the URL USERINFO (user:pass@host). Without this a loopback URL carrying
 *  basic-auth credentials (http://client:secret@localhost:3000/cb) would egress under the
 *  loopback exemption — query/fragment checks don't see userinfo. Returns "userinfo_credential"
 *  if the URL has a non-empty username or password. */
function userinfoCredentialReason(sourceUrl: string): string | undefined {
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.username || parsed.password) return "userinfo_credential";
  } catch { /* ignore unparseable URLs */ }
  return undefined;
}

function internalHostReason(sourceUrl: string, allowLoopback = false): string | undefined {
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase().replace(/\.$/, "");
    if (isLoopback(host)) return allowLoopback ? undefined : "internal_host";
    if (host === "localhost" || INTERNAL_HOST_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) {
      return "internal_host";
    }
    // Private/reserved IP literals (169.254.169.254 metadata, RFC1918, etc.) — reuse
    // the same classification as the fetch/browser SSRF guards.
    if (isPrivate(host)) return "internal_host";
  } catch { /* ignore unparseable URLs */ }
  return undefined;
}

/** Loopback (localhost, .localhost, 127.0.0.0/8, ::1 incl. bracketed [::1]) — a docs/example
 *  target that resolves to the reader's own machine, not a leaked internal endpoint. Exempt
 *  from the CONTENT-embedded scan (allowLoopback); kept on the SOURCE-url scan so captatum
 *  never fetches a loopback target. Reuses domain/policy's isLoopbackHost (bracket/zone
 *  stripping + octet/group validation) so IPv6 loopback is classified correctly. */
function isLoopback(host: string): boolean {
  return isLoopbackHost(host) || host.endsWith(".localhost");
}

/** Redact signed/tokenized query-param values from a URL before display (INFOLEAK-1). */
export function redactSignedQueryParams(url: string): string {
  try {
    const parsed = new URL(url);
    let redacted = false;
    for (const key of parsed.searchParams.keys()) {
      if (SIGNED_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, "[REDACTED]");
        redacted = true;
      }
    }
    return redacted ? parsed.href : url;
  } catch {
    return url;
  }
}

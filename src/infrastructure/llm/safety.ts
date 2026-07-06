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
import {
  CONTENT_CREDENTIAL_QUERY_KEYS,
  fragmentCredentialReason,
  internalHostReason,
  loopbackOAuthCredentialReason,
  SIGNED_QUERY_KEYS,
  signedUrlReason,
  userinfoCredentialReason,
} from "./sensitive-urls.ts";

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

/** Bounded URL-literal scan for embedded signed/internal URLs in content. Two alternations:
 *  (1) an OPTIONAL userinfo (user:pass@) then a bracketed IPv6 host, optional port, and a
 *  path/query/fragment that MUST start with '/', '?', or '#' — so prose immediately after the
 *  literal ('.', ',', '!', a markdown ']') is never absorbed, while a real path/query/fragment
 *  (incl. a credential fragment) is captured. The userinfo is '@'-anchored so it can't absorb
 *  non-userinfo prose. (2) a normal URL that excludes ']' (so a prose bracket around it stops
 *  cleanly) but ALLOWS '[' — a literal '[' in a path before a credential query (e.g.
 *  https://files.example/a[draft?access_token=…) must not truncate the match. The IPv6 alternation
 *  owns '[' at the host position, so allowing it in a normal path is safe. Bounded vs ReDoS. */
const SIGNED_URL_IN_CONTENT = /https?:\/\/(?:[^\s"'<>)\]\[@\/]+(?::[^\s"'<>)\]\[@\/]*)?@)?\[[^\]\s]{1,79}\](?::\d{1,5})?(?:[\/?#][^\s"'<>)\]]*)?|https?:\/\/[^\s"'<>)\]]{1,512}/gi;
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
  // A public page that merely LINKS a cloud-presigned / OAuth / signed URL or an internal host
  // must not egress to a hosted LLM. Bounded scan (ReDoS/DoS hygiene). Only real credential keys
  // are matched (CONTENT_CREDENTIAL_QUERY_KEYS) — not the generic ad/CDN keys (`token`/`key`/
  // `auth`/`expires`) that caused the #44 news-page false-positive regression. The credential
  // patterns above already scanned the FULL content.
  const head = content.length > MAX_CONTENT_SCAN ? content.slice(0, MAX_CONTENT_SCAN) : content;
  for (const match of head.matchAll(SIGNED_URL_IN_CONTENT)) {
    // allowLoopback: a public page that LINKS http://localhost:PORT (a docs/setup example — resolves
    // to the READER's machine, not a leaked endpoint) is not flagged. RFC1918 / 169.254.169.254 /
    // .corp / .internal are. A credential ANYWHERE on the URL — query key, fragment key (HTML-escaped
    // &amp; normalized), userinfo (user:pass@), or an OAuth code/refresh_token on a loopback redirect
    // — is checked BEFORE the exemption. Trim trailing prose punctuation a normal URL picked up
    // (no ']' — the IPv6 close + the path's [/?#] boundary keep brackets out of the match).
    const url = match[0].replace(/[.,;:!?)]+$/, "");
    const reason = signedUrlReason(url, CONTENT_CREDENTIAL_QUERY_KEYS)
      ?? fragmentCredentialReason(url, CONTENT_CREDENTIAL_QUERY_KEYS)
      ?? userinfoCredentialReason(url)
      ?? loopbackOAuthCredentialReason(url)
      ?? internalHostReason(url, true);
    if (reason) return { sensitive: true, reason: `content_embedded_${reason}` };
  }
  return { sensitive: false };
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

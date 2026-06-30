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
import { isPrivate } from "../../domain/policy.ts";

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

/** Bounded URL-literal scan for embedded signed/internal URLs in content. */
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
    const reason = signedUrlReason(match[0], CONTENT_CREDENTIAL_QUERY_KEYS) ?? internalHostReason(match[0]);
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
  // TRANSFORM-4: also detect high-entropy path segments (CDN/JWT-in-path tokens).
  const segments = parsed.pathname.split("/").filter(Boolean);
  for (const seg of segments) {
    if (looksLikeToken(seg)) return "signed_or_tokenized_url";
  }
  return undefined;
}

/** Min path-segment length to consider it a token. Real opaque tokens (JWT
 *  segments, AWS signatures, share-link IDs) are ≥40 chars; shorter segments are
 *  almost always slugs/short-IDs. CDN hashes (md5/sha1/sha256) are rejected by
 *  looksLikeToken's alphabet check below, not by length, so 40 is safe here. */
const MIN_TOKEN_SEGMENT_LEN = 40;

/** Heuristic: does a path segment look like an opaque credential token (JWT-in-
 *  path, presigned signature, share-link) vs ordinary content? A real token
 *  carries entropy across the FULL base64url alphabet (mixed case + digits), NOT
 *  just hex or decimal. So pure-hex asset hashes and pure-decimal IDs are
 *  rejected outright, and a letter-rich mix is required (JWT/opaque tokens are
 *  letter-dominant — this also catches letter-heavy tokens a digit-ratio rule
 *  would miss). */
function looksLikeToken(seg: string): boolean {
  if (seg.length < MIN_TOKEN_SEGMENT_LEN) return false;
  if (!/^[A-Za-z0-9_.-]+$/.test(seg)) return false;
  // Evaluate the STEM: drop a trailing short extension (.js/.jpg/.css/…) so an
  // asset filename like `<sha1>.js` is judged on its hash core, not the full name.
  const stem = seg.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  if (/^[0-9a-f]+$/i.test(stem)) return false; // pure hex → md5/sha1/sha256 asset hash
  if (/^[0-9]+$/.test(stem)) return false;     // pure decimal → DB PK / catalog ID
  const letters = (stem.match(/[A-Za-z]/g) ?? []).length;
  return letters >= stem.length * 0.20;
}

function internalHostReason(sourceUrl: string): string | undefined {
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase().replace(/\.$/, "");
    if (host === "localhost" || INTERNAL_HOST_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) {
      return "internal_host";
    }
    // Private/reserved IP literals (169.254.169.254 metadata, RFC1918, etc.) — reuse
    // the same classification as the fetch/browser SSRF guards.
    if (isPrivate(host)) return "internal_host";
  } catch { /* ignore unparseable URLs */ }
  return undefined;
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

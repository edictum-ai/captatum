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
];

const SENSITIVE_HEADER_PATTERNS = [
  /[Aa]uthorization:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/,
  /[Ss]et-[Cc]ookie:\s*[^=\s;]{1,64}=[^;\s<]{16,}/,
];

const SIGNED_QUERY_KEYS = new Set([
  "access_token",
  "api_key",
  "auth",
  "expires",
  "key",
  "signature",
  "sig",
  "token",
  "x-amz-credential",
  "x-amz-signature",
  "x-amz-security-token",
  "x-goog-signature",
]);

const INTERNAL_HOST_SUFFIXES = [
  ".local", ".internal", ".corp", ".intranet", ".localhost", ".priv",
  ...(process.env.INTERNAL_HOST_SUFFIXES ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
];

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
  return { sensitive: false };
}

function signedUrlReason(sourceUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return undefined;
  }

  for (const key of parsed.searchParams.keys()) {
    if (SIGNED_QUERY_KEYS.has(key.toLowerCase())) return "signed_or_tokenized_url";
  }
  // TRANSFORM-4: also detect high-entropy path segments (CDN/JWT-in-path tokens).
  const segments = parsed.pathname.split("/").filter(Boolean);
  for (const seg of segments) {
    if (seg.length >= 40 && looksLikeToken(seg)) return "signed_or_tokenized_url";
  }
  return undefined;
}

/** Heuristic: a path segment looks like a token if it's 40+ chars of base64url/hex
 *  AND has a high digit ratio (tokens are high-entropy; SEO slugs are mostly letters). */
function looksLikeToken(seg: string): boolean {
  if (!/^[A-Za-z0-9_.-]+$/.test(seg)) return false;
  const digits = (seg.match(/[0-9]/g) ?? []).length;
  return digits >= seg.length * 0.25;
}

function internalHostReason(sourceUrl: string): string | undefined {
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase().replace(/\.$/, "");
    if (host === "localhost" || INTERNAL_HOST_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) {
      return "internal_host";
    }
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

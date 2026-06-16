const SENSITIVE_TEXT = [
  /\bauthorization\s*:/i,
  /\bset-cookie\s*:/i,
  /\bcookie\s*:/i,
  /\bapi[_ -]?key\b/i,
  /\baccess[_ -]?token\b/i,
  /\brefresh[_ -]?token\b/i,
  /\bprivate[_ -]?key\b/i,
  /\bpassword\b/i,
  /\bsecret\b/i,
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
  "x-goog-signature",
]);

export interface SensitivitySignal {
  sensitive: boolean;
  reason?: string;
}

export function detectSensitiveTransformInput(input: {
  content: string;
  sourceUrl?: string;
}): SensitivitySignal {
  const urlReason = input.sourceUrl ? signedUrlReason(input.sourceUrl) : undefined;
  if (urlReason) return { sensitive: true, reason: urlReason };

  const matched = SENSITIVE_TEXT.find((pattern) => pattern.test(input.content));
  if (matched) return { sensitive: true, reason: "content_sensitive_signal" };
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
  return undefined;
}

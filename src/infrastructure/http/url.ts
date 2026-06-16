import { reject } from "./errors.ts";

export interface NormalizedUrl {
  readonly url: URL;
  readonly finalUrl: string;
  readonly hostname: string;
  readonly hostHeader: string;
}

const CRLF = /[\r\n]|%0d|%0a/i;

export function normalizeInitialUrl(input: string): NormalizedUrl {
  if (CRLF.test(input)) {
    reject("crlf_url", "URL contains a forbidden CRLF sequence");
  }
  return normalizeParsedUrl(parseAbsoluteUrl(input));
}

export function normalizeRedirectUrl(location: string, base: URL): NormalizedUrl {
  if (CRLF.test(location)) {
    reject("crlf_url", "Redirect URL contains a forbidden CRLF sequence");
  }
  let parsed: URL;
  try {
    parsed = new URL(location, base);
  } catch {
    reject("invalid_url", "Redirect URL is invalid");
  }
  return normalizeParsedUrl(parsed);
}

export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

export function headerValue(
  headers: Record<string, string | string[] | number | undefined>,
  name: string,
): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    if (Array.isArray(value)) return value[0] ? String(value[0]) : "";
    return String(value);
  }
  return "";
}

export function isLocalHostname(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname).toLowerCase();
  return host === "localhost" || host.endsWith(".localhost");
}

function parseAbsoluteUrl(input: string): URL {
  try {
    return new URL(input);
  } catch {
    reject("invalid_url", "URL is invalid");
  }
}

function normalizeParsedUrl(parsed: URL): NormalizedUrl {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    reject("unsupported_scheme", "Only http and https URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    reject("userinfo_url", "URLs with userinfo are not allowed");
  }
  if (!parsed.hostname) {
    reject("invalid_url", "URL must include a hostname");
  }

  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";

  return {
    url: parsed,
    finalUrl: parsed.href,
    hostname: stripIpv6Brackets(parsed.hostname),
    hostHeader: parsed.host,
  };
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

import type { Result } from "../domain/result.ts";
import { shortSchemaType, CONTENT_TYPES } from "../domain/content-types.ts";
import { isPinHost } from "../domain/pin-url.ts";

/**
 * Agent-facing classification of a Result's content kind and access state.
 * These are PRESENTATION concerns (how to describe the result to an agent), so
 * they live in the MCP interface layer and derive purely from the domain Result
 * — the domain Result shape is untouched.
 */

export type ContentType = "article" | "job" | "json" | "pin" | "product" | "spa" | "unknown";

export interface AccessInfo {
  mainContentAccessible: boolean;
  gated: boolean;
  gateReason: "paywall" | "js-required" | "captcha" | "bot_verification" | "byte_cap" | "http_error" | "none";
  /** The anti-bot vendor when gateReason is "captcha" (#41 Half A). Absent for "bot_verification"
   *  (vendor not attributable — #151). */
  challengeProvider?: string;
}

/** Strict schema.org Article family. WebPage (a container) and event/recipe/
 * review/course are intentionally excluded so generic/landing pages are not
 * mislabeled "article" — those fall through to og:type / spa / unknown. */
const ARTICLE_TYPES = new Set([
  "article", "newsarticle", "blogposting", "techarticle", "scholarlyarticle", "report",
]);

/** Whether the run returned real body content the agent can consume. */
export function hasContent(result: Result): boolean {
  const realTier = result.tier === 1 || result.tier === 2 || result.tier === 3;
  return realTier && result.result.trim().length > 0;
}

/** The truncation advisory code (`max_bytes` = a clean cap prefix, or `body_read_error` = a
 *  mid-read transport truncation) when the result is a SUCCESSFUL PARTIAL — real content that
 *  was cut. Absent for a zero-byte TOTAL failure, which carries the same `body_read_error` code
 *  but is a hard `tier:"error"` reject with no partial bytes — that is a failed fetch, NOT a
 *  truncated success, so it must not be tagged truncated/gated (#149 codex P2). */
export function truncatedReason(result: Result): "max_bytes" | "body_read_error" | undefined {
  if (result.tier === "error") return undefined;
  const code = result.errors.find((e) => e.code === "max_bytes" || e.code === "body_read_error")?.code;
  return code === "max_bytes" || code === "body_read_error" ? code : undefined;
}

/** application-local mirror of infrastructure/http/body.ts isJsonContentType (tiny + stable; also
 *  mirrored in antibot-evidence.ts — keep in sync; a drift weakens the #151 JSON FP gate). */
function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const primary = contentType.split(";")[0].trim().toLowerCase();
  return primary === "application/json" || primary.endsWith("+json");
}

export function classifyContentType(result: Result): ContentType {
  // A declared JSON response is JSON, full stop — before any HTML/structured/host heuristic
  // (which would label it "unknown" and imply an HTML read). Inlined here (not imported from
  // infrastructure/http/body.ts) to keep this application module free of a concrete-infra import.
  if (isJsonContentType(result.contentType)) return "json";

  // Explicit schema.org / og:type declarations are authoritative and win over
  // the host heuristic — a Pinterest careers page with a JobPosting is "job".
  const jsonLdType = bestContentType(primaryTypes(result.structured?.jsonLd));
  if (jsonLdType) return jsonLdType;

  const ogType = (result.structured?.og?.["og:type"] ?? "").toLowerCase();
  if (ogType === "product") return "product";
  if (ogType === "article") return "article";

  if (isPinHost(result.finalUrl || result.url)) {
    return "pin";
  }

  if (result.jsRequired) return "spa";
  return "unknown";
}

// Pinterest pin-URL classification (isPinHost / isPinDetailPage) now lives in
// domain/pin-url.ts — pure, shared by the contentType classifier (here) and the shell-gate
// (SocialMediaPosting gate-scoping). Imported above.

export function classifyAccess(result: Result): AccessInfo {
  const mainContentAccessible = hasContent(result);
  // Generic browser-verification wall (#151): a 429/503 "verifying your browser" interstitial, no
  // attributable vendor. Precedes code>=400 http_error (the wall is ≥400) or it collapses to http_error.
  if (result.botVerification) {
    return { mainContentAccessible: false, gated: true, gateReason: "bot_verification" };
  }
  // Anti-bot challenge wall (#41 Half A): the fetched bytes are a bot-protection
  // interstitial, not page content. Takes precedence — never silently pass it.
  if (result.challengeProvider) {
    return { mainContentAccessible: false, gated: true, gateReason: "captcha", challengeProvider: result.challengeProvider };
  }
  // HTTP error (4xx/5xx): the fetch returned an error page, not accessible content. Takes
  // precedence over paywall/byte_cap/js-required so the receipt never presents an error
  // response as a successful, public, non-gated fetch. The body is still in result.result.
  if (Number(result.code) >= 400) {
    return { mainContentAccessible: false, gated: true, gateReason: "http_error" };
  }
  if (isPaywalled(result.structured?.jsonLd)) {
    return { mainContentAccessible, gated: true, gateReason: "paywall" };
  }
  const truncation = truncatedReason(result);
  if (truncation) {
    // Content was truncated — either at the byte cap (max_bytes, a clean prefix) or mid-read by a
    // transport error (body_read_error, possibly garbled from a broken gzip stream). Either way the
    // agent must NOT treat the partial bytes as complete/public — flag it gated (#149). `truncatedReason`
    // excludes a zero-byte total failure (tier:error), which is a failed fetch, not a truncated success.
    return { mainContentAccessible, gated: true, gateReason: "byte_cap" };
  }
  // Empty content on a page that needed JS we could not run: likely gated
  // behind a login wall / client-rendered gate.
  if (!mainContentAccessible && needsRender(result)) {
    return { mainContentAccessible, gated: true, gateReason: "js-required" };
  }
  return { mainContentAccessible, gated: false, gateReason: "none" };
}

function needsRender(result: Result): boolean {
  return (
    result.tier === "render-blocked" ||
    result.tier === "render-unavailable" ||
    result.jsRequired
  );
}

/** Collect every short schema.org @type across top-level nodes and @graph. */
function primaryTypes(jsonLd: unknown): string[] {
  const types: string[] = [];
  for (const node of asArray(jsonLd)) {
    if (!isRecord(node)) continue;
    types.push(...typesOf(node));
    for (const child of graphNodes(node["@graph"])) types.push(...typesOf(child));
  }
  return types;
}

function typesOf(node: Record<string, unknown>): string[] {
  const type = node["@type"];
  const arr = Array.isArray(type) ? type.map(String) : type === undefined ? [] : [String(type)];
  return arr.map(shortSchemaType);
}

function mapType(type: string | undefined): ContentType | undefined {
  if (!type) return undefined;
  if (type === "jobposting") return "job";
  if (type === "product") return "product";
  if (ARTICLE_TYPES.has(type)) return "article";
  // The rest of CONTENT_TYPES (#152 widening: recipe/review/howto/faqpage/question/dataset/
  // softwareapplication/webapplication/media titles/business) → "article" (text/reference content;
  // a distinct ContentType value is an impl detail). Keeps gate-satisfying ⇒ non-unknown.
  return CONTENT_TYPES.has(type) ? "article" : undefined;
}

/** Highest-precedence content type from a list of short @types: job > product > article. */
function bestContentType(types: string[]): ContentType | undefined {
  let best: ContentType | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const type of types) {
    const mapped = mapType(type);
    if (mapped) {
      const rank = mapped === "job" ? 0 : mapped === "product" ? 1 : 2;
      if (rank < bestRank) {
        best = mapped;
        bestRank = rank;
      }
    }
  }
  return best;
}

/** True only when the page explicitly declares paid access (isAccessibleForFree=false). */
function isPaywalled(jsonLd: unknown): boolean {
  for (const node of asArray(jsonLd)) {
    if (!isRecord(node)) continue;
    if (isFalseFlag(node.isAccessibleForFree)) return true;
    for (const child of graphNodes(node["@graph"])) {
      if (isFalseFlag(child.isAccessibleForFree)) return true;
    }
  }
  return false;
}

function isFalseFlag(value: unknown): boolean {
  return value === false || value === "false";
}

function typeOf(node: Record<string, unknown>): string | undefined {
  const type = node["@type"];
  if (type === undefined) return undefined;
  const types = Array.isArray(type) ? type.map(String) : [String(type)];
  const found = types.find((t) => mapType(shortSchemaType(t)) !== undefined);
  return found === undefined ? undefined : shortSchemaType(found);
}

function graphNodes(graph: unknown): Record<string, unknown>[] {
  if (Array.isArray(graph)) return graph.filter(isRecord);
  if (isRecord(graph)) return [graph];
  return [];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

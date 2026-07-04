import type { Result } from "../domain/result.ts";

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
  gateReason: "paywall" | "login" | "captcha" | "byte_cap" | "none";
  /** The anti-bot vendor when gateReason is "captcha" (#41 Half A). */
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

/** application-local mirror of infrastructure/http/body.ts isJsonContentType (kept here to avoid
 *  an application → concrete-infra import; tiny + stable). True for application/json and +json. */
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

/** A genuine Pinterest host label, anchored at the END of the hostname: pinterest.com,
 *  country domains (pinterest.co.uk, pinterest.fr, pinterest.com.au, pinterest.com.uy,
 *  pinterest.com.py, ... — every real Pinterest tail is a 2-letter country code), and
 *  subdomains (www.). Any 2-letter ccTLD is accepted on purpose: an attacker who
 *  registers pinterest.<cc> controls that page end-to-end, so surfacing its bytes is
 *  not a cross-domain injection (captatum returns that attacker content regardless).
 *  3+-letter lookalikes (pinterest.com.evil, .com.foo, .xyz) and substring spoofs
 *  (xpinterest.com) do NOT match. Bounded alternatives only — no ReDoS surface. */
const PINTEREST_HOST = /(^|\.)pinterest\.(com|(?:com|co)\.[a-z]{2}|[a-z]{2})$/;

/** A Pinterest/pin.it URL (any pin page: a pin, board, profile, ...). */
export function isPinHost(url: string): boolean {
  const host = hostname(url);
  if (!host) return false;
  if (host === "pin.it" || host.endsWith(".pin.it")) return true;
  return PINTEREST_HOST.test(host);
}

/** A specific pin DETAIL page — a pinterest URL whose path is the pin route
 *  "/pin/<numeric-id>" (optionally under "/amp/"), or a pin.it short link. Stricter
 *  than isPinHost and than a bare "/pin/" substring: a board slug like "/alice/pin/"
 *  or a route like "/pin/create/" is NOT a pin detail page, so a social post there
 *  must not be treated as the page subject. */
export function isPinDetailPage(url: string): boolean {
  const host = hostname(url);
  if (!host) return false;
  if (host === "pin.it" || host.endsWith(".pin.it")) return true;
  if (!PINTEREST_HOST.test(host)) return false;
  try {
    return /^\/(?:amp\/)?pin\/\d+(?:\/|$)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function classifyAccess(result: Result): AccessInfo {
  const mainContentAccessible = hasContent(result);
  // Anti-bot challenge wall (#41 Half A): the fetched bytes are a bot-protection
  // interstitial, not page content. Takes precedence — never silently pass it.
  if (result.challengeProvider) {
    return { mainContentAccessible: false, gated: true, gateReason: "captcha", challengeProvider: result.challengeProvider };
  }
  if (isPaywalled(result.structured?.jsonLd)) {
    return { mainContentAccessible, gated: true, gateReason: "paywall" };
  }
  if (result.errors.some((error) => error.code === "max_bytes")) {
    return { mainContentAccessible, gated: true, gateReason: "byte_cap" };
  }
  // Empty content on a page that needed JS we could not run: likely gated
  // behind a login wall / client-rendered gate.
  if (!mainContentAccessible && needsRender(result)) {
    return { mainContentAccessible, gated: true, gateReason: "login" };
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
  return undefined;
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

/** Normalize a schema.org @type to its short lowercase form (e.g. "jobposting"). */
function shortSchemaType(value: string): string {
  const lower = value.toLowerCase().replace(/^https?:\/\/schema\.org\//, "");
  return lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
}

function hostname(url: string): string | undefined {
  try {
    // Lowercase + strip a trailing dot (the FQDN form "pinterest.com." is the same
    // host) so the explicit allowlist matches trailing-dot URLs too.
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return undefined;
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

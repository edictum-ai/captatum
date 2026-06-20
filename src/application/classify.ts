import type { Result } from "../domain/result.ts";

/**
 * Agent-facing classification of a Result's content kind and access state.
 * These are PRESENTATION concerns (how to describe the result to an agent), so
 * they live in the MCP interface layer and derive purely from the domain Result
 * — the domain Result shape is untouched.
 */

export type ContentType = "article" | "job" | "pin" | "product" | "spa" | "unknown";

export interface AccessInfo {
  mainContentAccessible: boolean;
  gated: boolean;
  gateReason: "paywall" | "login" | "captcha" | "byte_cap" | "none";
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

export function classifyContentType(result: Result): ContentType {
  // Explicit schema.org / og:type declarations are authoritative and win over
  // the host heuristic — a Pinterest careers page with a JobPosting is "job".
  const jsonLdType = bestContentType(primaryTypes(result.structured?.jsonLd));
  if (jsonLdType) return jsonLdType;

  const ogType = (result.structured?.og?.["og:type"] ?? "").toLowerCase();
  if (ogType === "product") return "product";
  if (ogType === "article") return "article";

  const host = hostname(result.finalUrl || result.url);
  if (host && (host.includes("pinterest.") || host === "pin.it" || host.endsWith(".pin.it"))) {
    return "pin";
  }

  if (result.jsRequired) return "spa";
  return "unknown";
}

export function classifyAccess(result: Result): AccessInfo {
  const mainContentAccessible = hasContent(result);
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
    return new URL(url).hostname.toLowerCase();
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

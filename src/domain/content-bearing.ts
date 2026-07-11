// Content-bearing predicate + lead harvest for the shell-gate's JSON-LD path and the low_value
// exclusion (#152; next step — and partial reversal — of #109). Pure domain.
//
// A JSON-LD node is content-bearing iff it declares a @type in CONTENT_TYPES AND carries a
// harvestable content field (harvestContentText yields non-empty) — OR a nested content-bearing
// entity is reachable via @graph / mainEntity / mainEntityOfPage / about / subject / hasPart /
// itemListElement. ALLOWLIST (CONTENT_TYPES) at the trust boundary, not blocklist: scaffolding
// (WebPage/WebSite/…), @type-less nodes, and metadata types (Organization/Person/Offer/
// VideoObject/…) do NOT satisfy even with a description — so a JS-rendered listing page whose
// static HTML carries only metadata JSON-LD escalates to render instead of stopping at an empty
// Tier-1 (the StartupJobs/NoFluffJobs bug).
//
// The gate (hasContentBearingJsonLd) and the Tier-1 lead harvest (firstContentHarvest) SHARE one
// walk (findFirstContentNode) so the invariant "gate satisfied ⇒ non-empty harvest" holds by
// construction for every non-social type. socialmediaposting is gate-scoped to pin-detail pages
// (isPinDetail) and harvested by tier1-payload's Pass 2, not here.
import { CONTENT_TYPES, shortTypes, shortSchemaType, NESTED_CONTENT_LINKS } from "./content-types.ts";
import { harvestContentText } from "./content-harvest.ts";

export { shortSchemaType, NESTED_CONTENT_LINKS } from "./content-types.ts"; // back-compat re-export

/** Cap on chained wrapper descent (mainEntity/about/subject/hasPart/itemListElement). Guards cycles. */
export const MAX_NESTED_DEPTH = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A single node is content-bearing: a CONTENT_TYPES @type WITH a non-trivial content field.
 *  socialmediaposting requires a pin-detail page (isPinDetail) + a non-empty articleBody. */
function nodeIsContentBearing(node: Record<string, unknown>, isPinDetail: boolean): boolean {
  const types = shortTypes(node);
  if (!types.some((t) => CONTENT_TYPES.has(t))) return false;
  // A NON-social content type decides it: harvestContentText tries social first (yields nothing —
  // the social case returns undefined) then the real type, so a co-typed ["SocialMediaPosting",
  // "Article"] still counts the Article (codex: don't let an embedded post vanish real content).
  if (types.some((t) => t !== "socialmediaposting" && CONTENT_TYPES.has(t))) {
    return harvestContentText(node) !== undefined;
  }
  // socialmediaposting only: gate-scoped to a pin-detail page + a non-empty articleBody.
  return isPinDetail && typeof node.articleBody === "string" && node.articleBody.trim().length > 0;
}

/** Shared walk: the first content-bearing node reachable from `value` (arrays, @graph, and the
 *  nested-content links, depth-capped + object-identity cycle-guarded). `allowSocial` includes
 *  socialmediaposting (the gate does; the Pass-1 lead harvest does not — Pass 2 owns it). */
function findFirstContentNode(
  value: unknown, isPinDetail: boolean, allowSocial: boolean, depth: number, seen: Set<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findFirstContentNode(v, isPinDetail, allowSocial, depth, seen);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const types = shortTypes(value);
  // "Social-only" = socialmediaposting is the node's ONLY content type. Those are skipped for the
  // lead (allowSocial=false; Pass 2 owns the pin caption). A CO-TYPED [SocialMediaPosting, Article]
  // is NOT social-only → included, so its Article is harvested (gate⇒non-empty holds) (codex).
  const ctypes = types.filter((t) => CONTENT_TYPES.has(t));
  const isSocialOnly = ctypes.length > 0 && ctypes.every((t) => t === "socialmediaposting");
  if ((!isSocialOnly || allowSocial) && nodeIsContentBearing(value, isPinDetail)) return value;
  if (depth >= MAX_NESTED_DEPTH) return undefined;
  const graph = findFirstContentNode(value["@graph"], isPinDetail, allowSocial, depth, seen);
  if (graph) return graph;
  for (const key of NESTED_CONTENT_LINKS) {
    const nested = findFirstContentNode(value[key], isPinDetail, allowSocial, depth + 1, seen);
    if (nested) return nested;
  }
  return undefined;
}

/** Whether JSON-LD carries content an agent can use WITHOUT rendering (the shell-gate's
 *  structured-data path). `isPinDetail` scopes socialmediaposting to pin-detail pages. */
export function hasContentBearingJsonLd(jsonLd: unknown, isPinDetail = false): boolean {
  return findFirstContentNode(jsonLd, isPinDetail, true, 0, new Set()) !== undefined;
}

/** The first non-social content node's harvestable text (the Tier-1 result.text lead). Mirrors
 *  the gate's walk so gate-satisfied ⇒ non-empty (for non-social types). `forLead` skips an
 *  Article's `articleBody` to avoid duplicating the visible body — but the caller passes forLead =
 *  hasVisibleText, so an articleBody-only shell with NO visible text still leads with articleBody
 *  (gate⇒non-empty holds). undefined if none. */
export function firstContentHarvest(jsonLd: unknown, isPinDetail = false, forLead = true): string | undefined {
  const node = findFirstContentNode(jsonLd, isPinDetail, false, 0, new Set());
  return node ? harvestContentText(node, { forLead }) : undefined;
}

/** The (capped) CONTENT_TYPES @types of every content-bearing node reachable from jsonLd — the SAME
 *  walk + content-bearing notion as `hasContentBearingJsonLd`, so the contentType classifier mirrors
 *  the gate exactly: capped @type, field-required (a name-only `Movie` the gate rejects is NOT
 *  collected), nested-link descent. The classifier's content type therefore never advertises content
 *  the gate ignored (#152, codex). */
export function contentBearingTypes(jsonLd: unknown, isPinDetail = false): string[] {
  const types: string[] = [];
  collectContentTypes(jsonLd, isPinDetail, 0, new Set(), types);
  return types;
}

function collectContentTypes(value: unknown, isPinDetail: boolean, depth: number, seen: Set<Record<string, unknown>>, types: string[]): void {
  if (Array.isArray(value)) { for (const v of value) collectContentTypes(v, isPinDetail, depth, seen, types); return; }
  if (!isRecord(value) || seen.has(value)) return;
  seen.add(value);
  if (nodeIsContentBearing(value, isPinDetail)) {
    for (const t of shortTypes(value)) if (CONTENT_TYPES.has(t)) types.push(t);
  }
  if (depth >= MAX_NESTED_DEPTH) return;
  collectContentTypes(value["@graph"], isPinDetail, depth, seen, types);
  for (const key of NESTED_CONTENT_LINKS) collectContentTypes(value[key], isPinDetail, depth + 1, seen, types);
}

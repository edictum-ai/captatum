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
  const ctypes = shortTypes(node).filter((t) => CONTENT_TYPES.has(t));
  if (ctypes.length === 0) return false;
  // A pin-detail page's socialmediaposting articleBody is the caption — counts EVEN on a co-typed
  // node (e.g. [SocialMediaPosting, Product] with only articleBody, no Product description), so the
  // gate does not reject an otherwise-harvestable pin shell (Pass 2 surfaces the caption) (codex).
  if (isPinDetail && ctypes.includes("socialmediaposting") && typeof node.articleBody === "string" && node.articleBody.trim().length > 0) return true;
  // Otherwise a NON-social content type decides it: harvestContentText tries social first (yields
  // nothing) then the real type, so a co-typed ["SocialMediaPosting", "Article"] counts the Article.
  if (ctypes.some((t) => t !== "socialmediaposting")) return harvestContentText(node) !== undefined;
  // socialmediaposting only, off-pin or no articleBody → not content-bearing.
  return false;
}

/** Iteratively flatten nested arrays, ORDER-PRESERVING + O(n). Array WRAPPERS are containers, not
 *  semantic nesting — they must NOT consume the depth budget (the extractJsonLd multi-script shape
 *  [[{@graph:[…]}, …], node] has several array layers before content; recursing them at depth+1
 *  exhausted MAX_NESTED_DEPTH on the wrappers). Explicit-stack DFS: order-preserving (document order
 *  — the first content node / first pin caption stays first), O(n) time, no array shifting, no
 *  call-stack growth (a deep/wide array of distinct wrappers can't overflow or stall the loop) (codex). */
function flattenArrays(value: unknown): unknown[] {
  const out: unknown[] = [];
  const stack: Array<{ arr: unknown[]; i: number }> = [];
  let arr: unknown[] = Array.isArray(value) ? value : [value];
  let i = 0;
  while (stack.length > 0 || i < arr.length) {
    if (i >= arr.length) { const f = stack.pop()!; arr = f.arr; i = f.i; continue; } // resume parent
    const v = arr[i++];
    if (Array.isArray(v)) { stack.push({ arr, i }); arr = v; i = 0; } // descend into the nested array
    else out.push(v);
  }
  return out;
}

/** Shared walk: the first content-bearing node reachable from `value` (flattened arrays, @graph, and
 *  the nested-content links). Only @graph / nested-links consume depth (semantic descent); array
 *  wrappers are flattened iteratively (no depth cost). `allowSocial` includes socialmediaposting. */
function findFirstContentNode(
  value: unknown, isPinDetail: boolean, allowSocial: boolean, depth: number, seen: Set<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (depth >= MAX_NESTED_DEPTH) return undefined; // caps @graph / nested-link descent (arrays flatten, don't recurse)
  for (const item of flattenArrays(value)) {
    if (!isRecord(item) || seen.has(item)) continue;
    seen.add(item);
    const ctypes = shortTypes(item).filter((t) => CONTENT_TYPES.has(t));
    // "Social-only" = socialmediaposting is the node's ONLY content type → skipped for the lead
    // (allowSocial=false; Pass 2 owns the caption). A CO-TYPED [SocialMediaPosting, Article] is NOT
    // social-only → included (its Article is harvested; gate⇒non-empty) (codex).
    const isSocialOnly = ctypes.length > 0 && ctypes.every((t) => t === "socialmediaposting");
    if ((!isSocialOnly || allowSocial) && nodeIsContentBearing(item, isPinDetail)) return item;
    const graph = findFirstContentNode(item["@graph"], isPinDetail, allowSocial, depth + 1, seen);
    if (graph) return graph;
    for (const key of NESTED_CONTENT_LINKS) {
      const nested = findFirstContentNode(item[key], isPinDetail, allowSocial, depth + 1, seen);
      if (nested) return nested;
    }
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
  if (depth >= MAX_NESTED_DEPTH) return; // caps @graph / nested descent (arrays flatten, don't consume depth)
  for (const item of flattenArrays(value)) {
    if (!isRecord(item) || seen.has(item)) continue;
    seen.add(item);
    const bearing = nodeIsContentBearing(item, isPinDetail);
    if (bearing) {
      for (const t of shortTypes(item)) if (CONTENT_TYPES.has(t)) types.push(t);
    }
    // A content-bearing node is TERMINAL for classification (its own type is primary) — do NOT descend
    // its @graph or related links (an Article carrying its own @graph:[Product] stays 'article'). A
    // wrapper (non-bearing) descends @graph (flat expansion) + the nested links to find content.
    if (!bearing) {
      collectContentTypes(item["@graph"], isPinDetail, depth + 1, seen, types);
      for (const key of NESTED_CONTENT_LINKS) collectContentTypes(item[key], isPinDetail, depth + 1, seen, types);
    }
  }
}

/** Every SocialMediaPosting node reachable from jsonLd (top-level, @graph, AND the nested-content
 *  links — depth-capped + cycle-guarded) — so the pin-caption lead finds a caption nested behind a
 *  wrapper (WebPage.mainEntity → SocialMediaPosting), not just top-level/@graph ones (#152, codex). */
export function collectPostingNodes(jsonLd: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  walkPostings(jsonLd, 0, new Set(), out);
  return out;
}
function walkPostings(value: unknown, depth: number, seen: Set<Record<string, unknown>>, out: Record<string, unknown>[]): void {
  if (depth >= MAX_NESTED_DEPTH) return; // arrays flatten (don't consume depth); @graph/nested do
  for (const item of flattenArrays(value)) {
    if (!isRecord(item) || seen.has(item)) continue;
    seen.add(item);
    if (shortTypes(item).includes("socialmediaposting")) out.push(item);
    walkPostings(item["@graph"], depth + 1, seen, out);
    for (const key of NESTED_CONTENT_LINKS) walkPostings(item[key], depth + 1, seen, out);
  }
}

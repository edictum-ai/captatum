// Content-bearing structured-data predicate: does the JSON-LD carry content an agent can use
// WITHOUT rendering? Shared by the shell-gate (Tier-1 → render escalation) and content-quality
// (low_value exclusion) so the two NEVER drift on what counts as "real content" (#159 codex).
// Pure domain — operates only on the parsed structured data (no infra imports).
//
// A node is content-bearing if it is a real data node (any @type that isn't ONLY scaffolding, OR
// any data key beyond @context/@id/@graph), OR — if it IS scaffolding-only (WebPage/WebSite/…) —
// it carries a non-empty content property (description/articleBody/…) or an inline content entity
// (mainEntity/about/hasPart/…). `null`/`[]`/`{}`/a context-only node do NOT count (#81/#109).

/** Normalize a schema.org @type to its short lowercase form (e.g. "jobposting"), flattening full
 *  IRI forms (https://schema.org/WebPage → webpage). Exported (an early `export` also lets
 *  `node --check` detect this import-free module as ESM + apply type-stripping). */
export function shortSchemaType(value: string): string {
  const lower = value.toLowerCase().replace(/^https?:\/\/schema\.org\//, "").replace(/\/+$/, "");
  return lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
}

/** @type values that are page-structure METADATA, not content. A node typed ONLY as one of these
 *  is "scaffolding" — it labels the page (name/url) but carries no body content, so it must not
 *  satisfy the shell-gate / low_value-exclude on its own. Data types (Article/Product/JobPosting/…)
 *  and nodes with a content property still count. */
const SCAFFOLDING_TYPES = new Set([
  "webpage", "website", "collectionpage", "searchresultspage", "itempage",
  "breadcrumblist", "sitenavigationelement", "aboutpage", "contactpage", "profilepage",
]);

/** schema.org text properties whose non-empty value means real body content. */
const CONTENT_PROPERTIES = new Set(["description", "articleBody", "text", "headline", "abstract", "caption", "body"]);

function nodeTypes(node: Record<string, unknown>): string[] {
  const type = node["@type"];
  const raw = typeof type === "string" ? [type] : Array.isArray(type) ? type.filter((t): t is string => typeof t === "string") : [];
  return raw.map(shortSchemaType);
}

/** A node typed ONLY with scaffolding @types (e.g. WebPage) — needs a content property or nested
 *  entity to count. */
function isScaffoldingOnly(node: Record<string, unknown>): boolean {
  const types = nodeTypes(node);
  return types.length > 0 && types.every((t) => SCAFFOLDING_TYPES.has(t));
}

function hasNonEmptyContentProp(node: Record<string, unknown>): boolean {
  return Object.entries(node).some(
    ([key, value]) => CONTENT_PROPERTIES.has(key) && typeof value === "string" && value.trim().length > 0,
  );
}

/** schema.org properties that link a page-wrapper (WebPage/…) to its primary inline content entity.
 *  A URL string here is a reference, not content — only inline objects are followed. */
const NESTED_CONTENT_LINKS = ["mainEntity", "mainEntityOfPage", "about", "subject", "hasPart"];
/** Cap on chained scaffolding-wrapper descent (mainEntity → …) — guards isPartOf/hasPart cycles. */
const MAX_NESTED_DEPTH = 4;

/** Whether JSON-LD actually carries content an agent can use WITHOUT rendering — a typed node or a
 *  real data property. Recurses arrays and @graph. A scaffolding-only node (WebPage/WebSite/…)
 *  counts with a non-empty content property OR a content-bearing nested entity (#109). */
export function hasContentBearingJsonLd(jsonLd: unknown, depth = 0): boolean {
  if (Array.isArray(jsonLd)) return jsonLd.some((n) => hasContentBearingJsonLd(n, depth));
  if (!jsonLd || typeof jsonLd !== "object") return false;
  const node = jsonLd as Record<string, unknown>;
  if (hasContentBearingJsonLd(node["@graph"], depth)) return true;
  if (isScaffoldingOnly(node)) {
    return hasNonEmptyContentProp(node) || hasNestedContent(node, depth);
  }
  // A real node declares a @type or carries a data property beyond @context/@id/@graph.
  return Object.keys(node).some((key) => key !== "@context" && key !== "@id" && key !== "@graph");
}

function hasNestedContent(node: Record<string, unknown>, depth: number): boolean {
  if (depth >= MAX_NESTED_DEPTH) return false;
  return NESTED_CONTENT_LINKS.some((key) => {
    const value = node[key];
    return value !== undefined && value !== null && typeof value === "object"
      && hasContentBearingJsonLd(value as Record<string, unknown>, depth + 1);
  });
}

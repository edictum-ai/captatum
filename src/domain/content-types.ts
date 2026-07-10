// The frozen schema.org content-type allowlist + the shared @type normalizer for the
// shell-gate / Tier-1 harvester / contentType classifier (#152). Single source of truth
// (imported by content-bearing.ts, content-harvest.ts, classify.ts, tier1-payload.ts,
// images.ts) so the gate set == harvester set == classifier superset never drifts (#159).
//
// This is the contract surface: the gate's JSON-LD path is satisfied ONLY by a node whose
// @type is in CONTENT_TYPES (and which carries a harvestable content field — see
// content-bearing.ts). ALLOWLIST, not blocklist, at the trust boundary (untrusted JSON-LD):
// scaffolding (WebPage/WebSite/…), @type-less nodes, and metadata types (Organization/Person/
// Offer/VideoObject/…) are intentionally NOT here — they are harvested into structured.jsonLd
// for debug/raw but do not satisfy the gate.

/** Normalize a schema.org @type to its short lowercase form (e.g. "JobPosting",
 *  "https://schema.org/Article" → "article", "BlogPosting/" → "blogposting").
 *  Order matters and matches the long-standing code: lowercase → strip the schema.org IRI
 *  prefix → strip a trailing "/" → take the last "/"-segment → trim surrounding whitespace.
 *  (Strip-trailing-slash BEFORE the last-segment split, else "JobPosting/" → "".)
 *  CURIE/prefix forms (schema:JobPosting, s:JobPosting) are intentionally NOT normalized —
 *  they fail the Set lookup (a safe extra render, never a bypass). */
export function shortSchemaType(value: string): string {
  const lower = value.toLowerCase().replace(/^https?:\/\/schema\.org\//, "").replace(/\/+$/, "");
  const seg = lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
  return seg.trim();
}

/** The frozen allowlist of schema.org data types whose JSON-LD carries a page's PRIMARY,
 *  harvestable content — the gate set, the harvester set, and the contentType superset.
 *  Adding/removing a type is a contract change (frozen acceptance suite 152). */
export const CONTENT_TYPES: ReadonlySet<string> = new Set([
  // Article family
  "article", "newsarticle", "blogposting", "techarticle", "scholarlyarticle", "report",
  // Listings / commerce / courses
  "jobposting", "product", "event", "course",
  // Food / reviews
  "recipe", "review",
  // Knowledge / Q&A
  "howto", "faqpage", "question",
  // Software
  "softwareapplication", "webapplication",
  // Media titles
  "musicrecording", "book", "movie", "tvseries", "tvepisode", "game",
  // Data
  "dataset",
  // Business pages (description-harvested)
  "localbusiness", "restaurant", "store",
  // Pin captions — PIN-DETAIL PAGES ONLY (the gate passes isPinDetail; see content-bearing.ts)
  "socialmediaposting",
]);

/** The schema.org @types on a node (short, full-IRI, and array forms), normalized. The @type
 *  array is count-capped (first 64) so a 100k-@type array is O(64), not O(n) (#152 threat note). */
export const MAX_TYPE_ARRAY = 64;
export function shortTypes(node: Record<string, unknown> | null | undefined): string[] {
  if (!node) return [];
  const type = node["@type"];
  const raw = Array.isArray(type) ? type : type === undefined ? [] : [type];
  return raw.slice(0, MAX_TYPE_ARRAY).map(String).map(shortSchemaType);
}

/** Whether a node declares any @type in CONTENT_TYPES (the gate/harvest type set). */
export function isContentTyped(node: Record<string, unknown> | null | undefined): boolean {
  return shortTypes(node).some((t) => CONTENT_TYPES.has(t));
}

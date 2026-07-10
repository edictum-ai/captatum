// The bounded per-type Tier-1 content harvester (#152). Given a JSON-LD node whose @type is in
// CONTENT_TYPES, extract the page's primary harvestable text per the CONTENT_FIELDS map (a
// Review.reviewBody, FAQPage Q&As, HowTo steps incl. HowToSection nesting, Recipe instructions,
// a JobPosting.title, an Article.articleBody/headline, …). Used by:
//   - the shell-gate predicate (content-bearing ⇒ this yields non-empty) — content-bearing.ts
//   - the Tier-1 result.text lead — tier1-payload.ts leadDescription (Pass 1)
// socialmediaposting is NOT harvested here (the pin Pass-2 path in tier1-payload handles it);
// the gate checks it directly (isPinDetail + articleBody).
//
// Bounded untrusted-input extraction (threat model): every value is string-coerced + linearly
// HTML-stripped (the caller strips; here we only pull strings), length-capped, and arrays are
// count-capped SLICE-THEN-NORMALIZE (slice to first N before any per-element work) so a
// 100k-element step[]/mainEntity[] is O(N) not O(100k). No regex; no eval; values are DATA.
import { shortTypes } from "./content-types.ts";

/** Per-field text cap (~4 KiB) and per-array element cap (first 50). #152 threat note. */
const FIELD_MAX = 4096;
const ARRAY_MAX = 50;
/** HowToSection nesting depth cap (guards isPartOf/hasPart cycles). */
const MAX_SECTION_DEPTH = 4;

/** Pull a bounded string from an untrusted JSON-LD value: a string is used (capped); anything
 *  else yields undefined (we do NOT string-coerce objects — that would yield "[object Object]"). */
function textField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  if (!t) return undefined;
  return t.length > FIELD_MAX ? `${t.slice(0, FIELD_MAX - 1)}…` : t;
}

/** Read the first non-trivial field from `node` by name (in order). */
function firstField(node: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const v = textField(node[name]);
    if (v) return v;
  }
  return undefined;
}

/** Descend HowTo `step[]` / Recipe `recipeInstructions` across their schema.org shapes: a single
 *  Text string, a `Text[]` (string elements), an `ItemList` wrapper, `HowToStep[]` (.text), and
 *  `HowToSection` (recurse its `.itemListElement`/`.step`, depth-capped) BEFORE falling back to a
 *  name. Slice-then-normalize (codex: Text[]/ItemList were skipped). */
function harvestSteps(raw: unknown, depth = 0): string | undefined {
  if (typeof raw === "string") return textField(raw); // a single Text instruction
  if (raw && typeof raw === "object" && !Array.isArray(raw)) { // an ItemList wrapper / single step object
    const n = raw as Record<string, unknown>;
    const inner = n.itemListElement ?? n.step;
    // Depth-capped (codex): a nested {itemListElement:{itemListElement:…}} chain is untrusted page
    // data within the extraction cap — recurse with depth+1 + the same guard as HowToSection, else a
    // deep chain would overflow the stack before the shell-gate can fail closed.
    if (inner !== undefined && depth < MAX_SECTION_DEPTH) return harvestSteps(inner, depth + 1);
    return textField(n.text);
  }
  if (!Array.isArray(raw)) return undefined;
  const parts: string[] = [];
  for (const el of raw.slice(0, ARRAY_MAX)) {
    if (typeof el === "string") { const t = textField(el); if (t) { parts.push(t); continue; } } // Text[] element
    if (!el || typeof el !== "object") continue;
    const n = el as Record<string, unknown>;
    const text = textField(n.text); // HowToStep.text
    if (text) { parts.push(text); continue; }
    if (depth < MAX_SECTION_DEPTH) { // HowToSection / nested ItemList: descend its real steps first
      const inner = harvestSteps(n.itemListElement ?? n.step, depth + 1);
      if (inner) { parts.push(inner); continue; }
    }
    const name = textField(n.name); // last resort: a name-only step
    if (name) parts.push(name);
  }
  return parts.join(" · ") || undefined;
}

/** Descend FAQPage `mainEntity[]` (Question[]) → "Q: … A: …" pairs. Slice-then-normalize. */
function harvestFaq(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parts: string[] = [];
  for (const q of raw.slice(0, ARRAY_MAX)) {
    if (!q || typeof q !== "object") continue;
    const qn = q as Record<string, unknown>;
    const question = textField(qn.name);
    const ans = qn.acceptedAnswer;
    const answer = ans && typeof ans === "object" ? textField((ans as Record<string, unknown>).text) : textField(ans);
    if (question && answer) parts.push(`Q: ${question} A: ${answer}`);
    else if (question) parts.push(`Q: ${question}`);
    else if (answer) parts.push(answer);
  }
  return parts.join("  ") || undefined;
}

/** Harvest the page's primary content text from a content-typed JSON-LD node, per CONTENT_FIELDS.
 *  Returns undefined when the node carries no non-trivial content field (a bare
 *  {"@type":"JobPosting"} or a metadata-only node). `forLead` (the Tier-1 result.text lead) skips
 *  `articleBody` for the Article family — an Article's articleBody IS its visible body (already in
 *  `text`), so leading with it would duplicate; the gate's content-bearing check (forLead=false)
 *  still counts articleBody. The caller (leadDescription) HTML-strips the result. */
export function harvestContentText(
  node: Record<string, unknown> | null | undefined,
  opts: { forLead?: boolean } = {},
): string | undefined {
  if (!node) return undefined;
  const forLead = opts.forLead === true;
  for (const t of shortTypes(node)) {
    const out = harvestByType(t, node, forLead);
    if (out) return out;
  }
  return undefined;
}

function harvestByType(t: string, n: Record<string, unknown>, forLead: boolean): string | undefined {
  switch (t) {
    case "article": case "newsarticle": case "blogposting": case "techarticle":
    case "scholarlyarticle": case "report":
      // forLead skips articleBody (== the visible body) so the lead does not duplicate it.
      return forLead
        ? firstField(n, ["headline", "description"])
        : firstField(n, ["articleBody", "headline", "description"]);
    case "jobposting":
      // title OR description (a title-only JobPosting is content-bearing); the lead ALWAYS prefers
      // the richer description (a job title is short — don't lead with it), regardless of forLead
      // (forLead only governs Article's articleBody duplication, not this field order).
      return firstField(n, ["description", "title"]);
    case "review":
      return firstField(n, ["reviewBody", "description"]);
    case "recipe":
      return harvestSteps(n.recipeInstructions) ?? firstField(n, ["description"]);
    case "howto":
      return firstField(n, ["description"]) ?? harvestSteps(n.step);
    case "faqpage":
      return harvestFaq(n.mainEntity) ?? firstField(n, ["description"]);
    case "question":
      return harvestFaq([n]) ?? firstField(n, ["description"]); // a standalone Question node
    case "socialmediaposting":
      return undefined; // handled by the gate (isPinDetail) + leadDescription Pass 2
    default:
      // product/event/course/dataset/softwareapplication/webapplication/musicrecording/book/
      // movie/tvseries/tvepisode/game/localbusiness/restaurant/store — description only (no
      // name-only fallback: a bare {"@type":"Movie","name":"Inception"} must not satisfy).
      return firstField(n, ["description"]);
  }
}

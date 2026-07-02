// Strip DOM subtrees a browser would not render — `display:none` or the `hidden`
// attribute — so config blobs hidden in the markup do not leak into the "visible
// text" the Tier-1 extractor treats as page content.
//
// Real failure (vscdn/Netflix): a career page ships its themeOptions/branding
// config inside `<code style="display:none">` elements. The old extractor only
// stripped script/style/noscript/template/svg, so ~22KB of entity-encoded JSON was
// counted as visible body text — it crowded the real JobPosting content out of
// `output:raw` and satisfied the shell-gate so Tier-3 never ran.
//
// Implementation: a SINGLE left-to-right pass with an open-element stack and a
// suppression flag. `display:none`/`hidden` hides the whole subtree (a descendant
// cannot override it), so one suppressed region covers nested elements; the close
// tag pops the stack and ends suppression. Each character is visited once → O(n)
// regardless of how many hidden elements appear or how malformed their contents are
// (an earlier per-subtree rescanner was O(n²) on nested malformed tags). Comments
// are skipped wholesale so a `</tag>` inside one cannot end suppression, and start
// tags are read with the quote-aware scanner so a `<` inside an attribute cannot.
// `visibility:hidden` is intentionally NOT treated as hidden: unlike `display:none`
// it is inherited but cancellable by a `visibility:visible` descendant, so dropping
// its whole subtree would lose genuinely visible content. Input is char-capped at
// 1M upstream (REDOS-4). Start-tag reading is shared with html.ts so attribute
// parsing (incl. the prototype-pollution-safe key filter) lives in one place.
import { readStartTag, type AttributeMap } from "./html.ts";

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

interface StackFrame {
  name: string;
  /** True if this opener started the active suppressed region. */
  suppressor: boolean;
}

export function stripHiddenSubtrees(html: string, hiddenClasses: Set<string> = new Set()): string {
  const lower = html.toLowerCase();
  const len = html.length;
  let out = "";
  let i = 0;
  const stack: StackFrame[] = [];
  let suppressed = false;

  while (i < len) {
    // HTML comment — no tags inside; skip it whole.
    if (html.startsWith("<!--", i)) {
      const close = html.indexOf("-->", i + 4);
      const end = close === -1 ? len : close + 3;
      if (!suppressed) out += html.slice(i, end);
      i = end;
      continue;
    }
    if (html[i] !== "<") {
      const nextLt = html.indexOf("<", i);
      const end = nextLt === -1 ? len : nextLt;
      if (!suppressed) out += html.slice(i, end);
      i = end;
      continue;
    }
    const next = html[i + 1];
    if (next === "/") {
      const end = tagEndAt(html, i);
      popUntil(lower, stack, i + 2, (wasSuppressor) => { if (wasSuppressor) suppressed = false; });
      if (!suppressed) out += html.slice(i, end);
      i = Math.max(end, i + 1);
      continue;
    }
    if (next === undefined || next === "!" || next === "?") {
      // `<!doctype …>` / `<?xml …>` / a lone trailing `<` — self-contained, no subtree.
      if (next === undefined) { if (!suppressed) out += "<"; i += 1; continue; }
      const end = tagEndAt(html, i);
      if (!suppressed) out += html.slice(i, end);
      i = Math.max(end, i + 1);
      continue;
    }
    const tag = readStartTag(html, i);
    if (!tag) { if (!suppressed) out += "<"; i += 1; continue; }
    const advance = Math.max(tag.end, i + 1);
    if (VOID_ELEMENTS.has(tag.name)) {
      if (!suppressed) out += isHidden(tag.attrs, hiddenClasses) ? " " : html.slice(i, advance);
      i = advance;
      continue;
    }
    // Foreign (SVG/MathML) self-closing nodes like `<path display="none"/>` carry
    // no subtree — treating them as openers would leave suppression active until a
    // close that never arrives and drop all following siblings. A self-closing root
    // `<svg hidden/>`/`<math/>` counts too (the element itself opens the foreign
    // context). The trailing `/` is ignored in HTML, so only apply this for foreign
    // element names or inside a foreign context.
    if (
      tag.raw.endsWith("/>") &&
      (tag.name === "svg" || tag.name === "math" || stack.some((f) => f.name === "svg" || f.name === "math"))
    ) {
      if (!suppressed) out += isHidden(tag.attrs, hiddenClasses) ? " " : html.slice(i, advance);
      i = advance;
      continue;
    }
    const startsHidden = !suppressed && isHidden(tag.attrs, hiddenClasses);
    stack.push({ name: tag.name, suppressor: startsHidden });
    if (startsHidden) {
      suppressed = true;
      out += " "; // replace the hidden opener (matches stripElement spacing)
    } else if (!suppressed) {
      out += html.slice(i, advance);
    }
    i = advance;
  }
  return out;
}

/** `hidden` attribute, an actual `display:none` CSS declaration in the inline
 *  `style`, the SVG/XML `display="none"` presentation attribute, OR a class
 *  declared `display:none` in a `<style>` block (collected upstream by
 *  `collectHiddenDisplayNoneClasses`). Inline `style` display is AUTHORITATIVE —
 *  it overrides the `hidden` attr and classes (e.g. `style="display:block"` shows
 *  an element a class hid). Inline `style` is parsed per-declaration (split on `;`)
 *  so a custom-property value like `--brand: display:none` does NOT count, and a
 *  trailing `!important` is stripped before the value compare. The bare
 *  `display="none"` attribute covers SVG `<g display="none">`/`<text display="none">`
 *  (HTML elements don't use a `display` attribute, so this is SVG-specific and not
 *  cancellable by a descendant, unlike `visibility:hidden`). */
function isHidden(attrs: AttributeMap, hiddenClasses: Set<string>): boolean {
  if (typeof attrs.style === "string") {
    const disp = inlineDisplayValue(attrs.style);
    if (disp !== undefined) return disp === "none";
  }
  if (attrs.hidden !== undefined) return true;
  if (typeof attrs.display === "string" && attrs.display.trim().toLowerCase() === "none") return true;
  if (hiddenClasses.size > 0 && typeof attrs.class === "string") {
    for (const token of attrs.class.split(/\s+/)) {
      if (hiddenClasses.has(token)) return true;
    }
  }
  return false;
}

/** The value of the inline `style` `display` declaration (lowercased, `!important`
 *  stripped), or undefined when the style sets no `display`. Authoritative for
 *  hidden-detection because inline display wins over the `hidden` attr and classes. */
function inlineDisplayValue(style: string): string | undefined {
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    if (declaration.slice(0, colon).trim().toLowerCase() !== "display") continue;
    return declaration.slice(colon + 1).trim().toLowerCase().replace(/\s*!\s*important\s*$/, "");
  }
  return undefined;
}

/** Offset just past the `>` of the tag starting at `i` (close tags and
 *  declarations carry no meaningful quoted `>`). Guarantees progress. */
function tagEndAt(html: string, i: number): number {
  const gt = html.indexOf(">", i);
  return gt === -1 ? i + 2 : gt + 1;
}

/** Read the element name starting at `at` in the lowercased input. */
function tagNameAt(lower: string, at: number): string {
  let j = at;
  while (j < lower.length) {
    const c = lower[j];
    if (c === ">" || c === "/" || c === " " || c === "\t" || c === "\n" || c === "\r") break;
    j += 1;
  }
  return lower.slice(at, j);
}

/** Pop stack frames from the top down to and including the topmost frame whose name
 *  matches the close tag; invoke `onPop` for each suppressor popped (ending the
 *  suppressed region). A close with no matching open is ignored (auto-closed
 *  elsewhere or stray), mirroring lenient HTML parsing. */
function popUntil(
  lower: string,
  stack: StackFrame[],
  nameAt: number,
  onPop: (wasSuppressor: boolean) => void,
): void {
  const name = tagNameAt(lower, nameAt);
  if (!name) return;
  for (let j = stack.length - 1; j >= 0; j -= 1) {
    if (stack[j].name !== name) continue;
    for (let k = stack.length - 1; k >= j; k -= 1) {
      if (stack[k].suppressor) onPop(true);
    }
    stack.length = j;
    return;
  }
}

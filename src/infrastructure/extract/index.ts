import type { ProvenanceError } from "../../domain/result.ts";
import type { StructuredData } from "../../domain/platform.ts";
import type {
  HtmlExtraction,
  HtmlExtractionInput,
} from "../../application/use-cases/tier1-extract.ts";
import { isHtmlContentType } from "../http/body.ts";
import { extractVisibleText } from "./html.ts";
import { revealedReactBoundaryIds } from "./hidden.ts";
import { selectMainContentHtml, stripChromeFromRaw } from "./main-content.ts";
import { extractPageMetadata } from "./metadata.ts";
import { evaluateShellGate } from "./shell-gate.ts";

export type {
  HtmlExtraction,
  HtmlExtractionInput,
} from "../../application/use-cases/tier1-extract.ts";

export function extractHtml(input: HtmlExtractionInput): HtmlExtraction {
  const errors = [] as ProvenanceError[];
  const html = isHtmlContentType(input.contentType);
  // Non-HTML bodies (text/plain, markdown, JSON, XML, …) carry no HTML metadata, and running the
  // HTML scanners on them fabricates results — e.g. extractImages misparses a JSON string value
  // containing a badge URL as an <img> tag (registry.npmjs.org/%22…svg%22). Skip extractPageMetadata
  // for non-HTML: structured/title are empty, and the raw decoded body is returned as `text` (#94).
  const metadata = html
    ? extractPageMetadata(input.html, input.url, errors)
    : { title: undefined as string | undefined, structured: {} as StructuredData };
  // Scope visible text to the main-content <article> when present so site chrome (GitHub's nav
  // header, blog headers/footers) doesn't crowd out the README/body. Metadata (title/og/jsonLd)
  // is still extracted from the full page — only the visible TEXT is scoped. (#93)
  // Compute the React boundary reveal set ONCE from the full page + thread it through scoping +
  // extraction. A scoped <article> fragment loses the <script>$RC(...)</script> calls (stripped/
  // outside scope), so recomputing it from the fragment would empty the set + strip a React
  // boundary (#118 codex P1). Both selectMainContentHtml and extractVisibleText take it explicitly.
  const revealedIds = revealedReactBoundaryIds(input.html);
  // No main-content landmark → fall back to the FULL page MINUS site chrome (aside/nav/footer).
  // Otherwise an SPA shell whose static HTML carries only nav/TOC chrome (<p>/<h2> in <nav>/<aside>)
  // satisfies the shell-gate's hasContent threshold and ships the nav menu as "content" instead of
  // escalating to render (#144 — Jira REST v3: 13,630 chars of chrome, article JS-only).
  const text = html ? extractVisibleText(selectMainContentHtml(input.html, revealedIds) ?? stripChromeFromRaw(input.html, revealedIds), revealedIds) : input.html;
  const shellGate = evaluateShellGate({
    html: input.html,
    text,
    structured: metadata.structured,
    contentType: input.contentType,
  });

  return {
    title: metadata.title,
    text,
    structured: metadata.structured,
    shellGate,
    errors,
  };
}

export function hasStructuredFields(structured: StructuredData): boolean {
  return Object.keys(structured).length > 0;
}

export { evaluateShellGate, hasUsableStructuredData } from "./shell-gate.ts";

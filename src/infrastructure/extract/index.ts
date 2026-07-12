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
import { selectContentContainer } from "./content-container.ts";
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
  // Scope the visible text so site chrome (nav/header/footer/sidebar) doesn't lead the feed.
  // Precedence: a main-content landmark (<article>/<main>) > a recognized main-content container
  // (#165: cppreference #content, php.net #layout-content, …) > the chrome-stripped whole body.
  // An SPA shell whose static HTML carries only nav/TOC chrome then doesn't satisfy the shell-gate
  // and escalates to render (#144 — Jira REST v3). The chrome-stripped body is computed ONLY on the
  // no-landmark path (short-circuit on the common landmark-bearing fetch). A container overrides
  // footer-keep (a stronger content signal); with no container the footer-keeping whole body stands.
  // landmarkFound stays FALSE for a container — the shell-gate evaluates its text on merit, so an
  // empty <div id="content"> SPA shell still escalates to render (#165, #144).
  const landmark = html ? selectMainContentHtml(input.html, revealedIds) : null;
  const cleanedBody = html && landmark === null ? stripChromeFromRaw(input.html, revealedIds) : null;
  const container = cleanedBody !== null ? selectContentContainer(cleanedBody, revealedIds) : null;
  const scope = landmark ?? container ?? cleanedBody ?? input.html;
  const text = html ? extractVisibleText(scope, revealedIds) : input.html;
  const shellGate = evaluateShellGate({
    html: input.html,
    // hasContent's tag-check runs against the SAME scope the text came from (so a chrome <h2>/<p>
    // outside the scope can't satisfy it), and a selected landmark counts as content even short
    // (the scope is the landmark's inner html, no wrapper tag) (#160 codex r3/r4).
    contentHtml: scope,
    landmarkFound: landmark !== null,
    text,
    structured: metadata.structured,
    contentType: input.contentType,
    url: input.url,
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

import type { ProvenanceError } from "../../domain/result.ts";
import type { StructuredData } from "../../domain/platform.ts";
import type {
  HtmlExtraction,
  HtmlExtractionInput,
} from "../../application/use-cases/tier1-extract.ts";
import { isHtmlContentType } from "../http/body.ts";
import { extractVisibleText } from "./html.ts";
import { extractPageMetadata } from "./metadata.ts";
import { evaluateShellGate } from "./shell-gate.ts";

export type {
  HtmlExtraction,
  HtmlExtractionInput,
} from "../../application/use-cases/tier1-extract.ts";

export function extractHtml(input: HtmlExtractionInput): HtmlExtraction {
  const errors = [] as ProvenanceError[];
  const metadata = extractPageMetadata(input.html, input.url, errors);
  // A non-HTML body (text/plain, markdown, JSON, XML, …) is the COMPLETE intended response —
  // don't run it through the HTML tag-stripper / whitespace-collapser, which mangles angle-bracket
  // data (e.g. `{"x":"<b>hi</b>"}` → `{"x":" hi "}`) and collapses markdown newlines. Use the raw
  // decoded body verbatim. (JSON image/structured mis-extraction is gated separately at Tier-1 — #94.)
  const text = isHtmlContentType(input.contentType)
    ? extractVisibleText(input.html)
    : input.html.trim();
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

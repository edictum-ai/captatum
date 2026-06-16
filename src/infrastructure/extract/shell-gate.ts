import type { ShellGateEvidence } from "../../domain/shell-gate.ts";
import type { StructuredData } from "../../domain/platform.ts";
import { findStartTags } from "./html.ts";

const APP_ROOT_IDS = new Set(["__next", "app", "gatsby-focus-wrapper", "root", "svelte"]);
const LOW_VALUE_META = new Set(["charset", "generator", "theme-color", "viewport"]);

export function evaluateShellGate(input: {
  html: string;
  text: string;
  structured: StructuredData;
}): ShellGateEvidence {
  const wordCount = input.text ? input.text.split(/\s+/).length : 0;
  const evidence = {
    textLength: input.text.length,
    wordCount,
    scriptCount: findStartTags(input.html, "script").length,
    appRootFound: hasAppRoot(input.html),
    structuredDataFound: hasUsableStructuredData(input.structured),
  };

  if (evidence.structuredDataFound) {
    return { ...evidence, jsRequired: false, reason: "structured-data-found" };
  }

  if (hasContent(input.html, evidence.textLength, evidence.wordCount)) {
    return { ...evidence, jsRequired: false, reason: "content-present" };
  }

  return { ...evidence, jsRequired: true, reason: "empty-spa-shell" };
}

export function hasUsableStructuredData(structured: StructuredData): boolean {
  if (structured.jsonLd !== undefined || structured.appState !== undefined) return true;
  if (structured.og && Object.keys(structured.og).length > 0) return true;
  if (!structured.meta) return false;
  return Object.keys(structured.meta).some((key) => !LOW_VALUE_META.has(key));
}

function hasContent(html: string, textLength: number, wordCount: number): boolean {
  if (textLength >= 80 || wordCount >= 12) return true;
  if (textLength < 20) return false;
  return ["article", "main", "p", "h1", "h2", "h3"].some(
    (tag) => findStartTags(html, tag).length > 0,
  );
}

function hasAppRoot(html: string): boolean {
  for (const tag of findStartTags(html, "div")) {
    const id = tag.attrs.id?.toLowerCase();
    if (id && APP_ROOT_IDS.has(id)) return true;
    if (tag.attrs["data-reactroot"] !== undefined) return true;
  }
  return false;
}

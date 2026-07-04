import type { ShellGateEvidence } from "../../domain/shell-gate.ts";
import type { StructuredData } from "../../domain/platform.ts";
import { isHtmlContentType } from "../http/body.ts";
import { findStartTags } from "./html.ts";

const APP_ROOT_IDS = new Set(["__next", "app", "gatsby-focus-wrapper", "root", "svelte"]);

export function evaluateShellGate(input: {
  html: string;
  text: string;
  structured: StructuredData;
  contentType?: string;
}): ShellGateEvidence {
  const wordCount = input.text ? input.text.split(/\s+/).length : 0;
  const evidence = {
    textLength: input.text.length,
    wordCount,
    scriptCount: findStartTags(input.html, "script").length,
    appRootFound: hasAppRoot(input.html),
    structuredDataFound: hasUsableStructuredData(input.structured),
  };

  // A non-HTML body (text/plain, application/json, XML, image, …) is the COMPLETE intended
  // response however short — the "empty SPA shell needing JS" concept only exists for HTML.
  // Without this guard a 14-byte text/plain "404: Not Found" trips hasContent's <20-byte rule
  // and escalates to jsRequired, cascading to contentType="spa" + gateReason="login" (#92).
  // Absent content-type keeps the current HTML-fallback behavior so SPAs served without a
  // declared type still escalate to render when they are genuinely empty shells.
  if (input.contentType && !isHtmlContentType(input.contentType)) {
    return { ...evidence, jsRequired: false, reason: "content-present" };
  }

  if (evidence.structuredDataFound) {
    return { ...evidence, jsRequired: false, reason: "structured-data-found" };
  }

  if (hasContent(input.html, evidence.textLength, evidence.wordCount)) {
    return { ...evidence, jsRequired: false, reason: "content-present" };
  }

  return { ...evidence, jsRequired: true, reason: "empty-spa-shell" };
}

/**
 * Whether the structured data carries content an agent can use WITHOUT rendering.
 * Only JSON-LD and NAMED-FRAMEWORK embedded app state count — OG / twitter meta is
 * social-card metadata, NOT body content, and a generic `<script type="application/json"
 * id="config">` is config, not rendered page content. Counting either would let an
 * empty SPA shell stop at Tier-1 (regression: vue-realworld, react-shopping-cart
 * returned tier 1 with zero content because OG bypassed the shell-gate; a config-only
 * JSON script would do the same). Generic JSON scripts are still harvested into
 * appState for debug/structured access — they just don't satisfy the gate.
 */
export function hasUsableStructuredData(structured: StructuredData): boolean {
  if (hasContentBearingJsonLd(structured.jsonLd)) return true;
  return hasContentBearingAppState(structured.appState);
}

/**
 * Whether JSON-LD actually carries content an agent can use WITHOUT rendering — a
 * typed node or a real data property. `null` / `[]` / `{}` / a context-only
 * `{"@context":…}` node do NOT count: those are common on client-rendered SPA shells,
 * and treating any-defined jsonLd as usable let an empty `<script type="ld+json">[]`
 * stop a true empty shell from rendering, returning no content (#81). Recurses arrays
 * and `@graph`. (Trivial JSON-LD is still harvested into `structured` for debug/output.)
 */
function hasContentBearingJsonLd(jsonLd: unknown): boolean {
  if (Array.isArray(jsonLd)) return jsonLd.some(hasContentBearingJsonLd);
  if (!jsonLd || typeof jsonLd !== "object") return false;
  const node = jsonLd as Record<string, unknown>;
  if (hasContentBearingJsonLd(node["@graph"])) return true;
  // A real node declares a @type or carries a data property beyond @context/@id/@graph.
  return Object.keys(node).some((key) => key !== "@context" && key !== "@id" && key !== "@graph");
}

const CONTENT_BEARING_APP_STATE_KEYS = new Set([
  "__NEXT_DATA__",
  "__NUXT_DATA__",
  "__INITIAL_STATE__",
  "__PRELOADED_STATE__",
  "__APOLLO_STATE__",
]);

/** True only when appState carries a recognized framework state object (Next/Nuxt
 *  SSR data, Redux/Apollo/INITIAL state) — the keys that reliably hold rendered
 *  page content. An arbitrary embedded JSON blob does not. */
function hasContentBearingAppState(appState: unknown): boolean {
  if (!appState || typeof appState !== "object") return false;
  const keys = Object.keys(appState as Record<string, unknown>);
  return keys.some((key) => CONTENT_BEARING_APP_STATE_KEYS.has(key));
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

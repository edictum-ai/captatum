import type { Result } from "../../domain/result.ts";

/**
 * Build the content sent to the transform model. Prepends the page's extracted
 * metadata (title + OG/meta description) so the model has it even when the body
 * is gated or thin (e.g. Pinterest OG-meta-only pages where the body is behind a
 * login wall). JSON-LD, when present, is appended as verified structured data —
 * but with `articleBody`/`description` stripped, because those duplicate the
 * body text already in `result` and inflate the prompt (which made the primary
 * model fail/time out on large news articles — Estadão, El Mundo).
 */
export function transformContent(base: Result): string {
  const og = base.structured?.og;
  const description = og?.["og:description"] ?? base.structured?.meta?.description;
  const meta = [
    base.title ? `Title: ${base.title}` : null,
    description ? `Description: ${description}` : null,
  ].filter((line): line is string => line !== null);
  const stripped = stripVerboseFields(base.structured?.jsonLd);
  const jsonLd = stripped !== undefined
    ? `\n\n--- Verified structured data (JSON-LD) — prefer these fields ---\n${JSON.stringify(stripped, null, 2)}`
    : "";
  const preamble = meta.length > 0 ? `${meta.join("\n")}\n\n` : "";
  return `${preamble}${base.result}${jsonLd}`;
}

/**
 * Recursively drop `articleBody` and `description` from JSON-LD. Both are large
 * free-text fields that duplicate the visible body (already in `result`); the
 * remaining metadata (headline, author, datePosted, baseSalary, image, …) is
 * what makes JSON-LD worth appending.
 */
function stripVerboseFields(jsonLd: unknown): unknown {
  if (Array.isArray(jsonLd)) {
    const mapped = jsonLd.map(stripVerboseFields);
    return mapped.length > 0 ? mapped : undefined;
  }
  if (jsonLd && typeof jsonLd === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(jsonLd as Record<string, unknown>)) {
      if (key === "articleBody" || key === "description") continue;
      const stripped = stripVerboseFields(value);
      if (stripped !== undefined) out[key] = stripped;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return jsonLd;
}

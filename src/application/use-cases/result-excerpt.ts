import { TransformError } from "../ports/transformer.ts";

/**
 * Maximum chars of raw page content returned when the transform did NOT produce
 * a summary (provider unconfigured, no model fit, or all candidate models
 * failed). Without this, a failed summary dumps the entire page into the agent
 * context — token-heavy and not what the caller asked for. The full page is
 * still available via `output: "raw"`.
 */
const FALLBACK_EXCERPT_CHARS = 3_000;

/**
 * Bound raw fallback content to a token-safe excerpt with a note. Small content
 * (real summaries, short bodies) passes through unchanged.
 */
export function fallbackExcerpt(text: string): string {
  if (text.length <= FALLBACK_EXCERPT_CHARS) return text;
  const head = text.slice(0, FALLBACK_EXCERPT_CHARS).trimEnd();
  return `${head}\n\n[… transform unavailable — showing the first ${FALLBACK_EXCERPT_CHARS} characters of the page. Retry for a summary, or re-run with output:"raw" for the full content.]`;
}

/** Map a thrown transform error to a provenance error code. */
export function transformErrorCode(error: unknown): string {
  return error instanceof TransformError ? error.code : "transform_failed";
}

/** Best-effort error message, falling back when the thrown value has none. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

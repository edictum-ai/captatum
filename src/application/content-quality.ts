// Content-quality detection for a successful fetch whose bytes aren't real/usable content.
// Two conservative, HIGH-PRECISION detectors behind one `Result.contentQuality` field (#145/#150):
//   - "app_error": a RENDERED client-app error-boundary screen (HTTP 200, the crash text IS the
//     page content) → demoted to tier:error (#145).
//   - "low_value": HTTP success but near-empty useful content (thin extraction, e.g. "Careers")
//     → a non-fatal warning, status partial (#150).
// Conservative by design: each requires multiple strong signals so a legitimate page is not
// false-positive'd. Better to miss a thin page than to mislabel real content.
import type { Result } from "../domain/result.ts";
import { primaryTypes } from "./classify.ts";
import { CONTENT_TITLE_TYPES } from "./use-cases/tier1-payload.ts";

export type ContentQuality = "app_error" | "low_value";

/** Known client-app error-boundary signatures (#145) — the crash screen's text LEADS with one of
 *  these (startsWith, not includes: a help doc quoting "if you see 'Something went wrong'..." or a
 *  JSON error body must NOT be demoted). Curated, vendor-specific phrases. */
const APP_ERROR_SIGNATURES = [
  "something went wrong",
  "application error: a client-side exception",
  "a critical error occurred",
];
/** A crash screen's extracted text is short (it IS the error message). */
const APP_ERROR_MAX_CHARS = 300;
/** Titles that signal "this is a shell/landing, not the page's real subject". */
const GENERIC_TITLES = new Set(["careers", "career", "home", "loading", "untitled"]);
/** Low-value requires the page to be large but text-poor (bytes ≫ extracted text). */
const LOW_VALUE_MAX_TEXT = 500;
const LOW_VALUE_MIN_BYTES = 100_000;

/** A client-app crash into its error boundary (#145): a RENDERED page (tier 3 — error-boundary
 *  screens are a SPA phenomenon, so a Tier-1 help doc, a status page, or a JSON error body quoting
 *  the phrase is NOT flagged) whose short extracted text LEADS WITH a known crash signature. */
function detectAppError(result: Result): boolean {
  if (result.tier !== 3) return false;
  const text = result.result.trim().toLowerCase();
  if (text.length > APP_ERROR_MAX_CHARS) return false;
  return APP_ERROR_SIGNATURES.some((sig) => text.startsWith(sig));
}

/** A page that returned HTTP success but near-empty useful content (#150) — e.g. a rendered SPA
 *  whose visible text is just "Careers". Requires MULTIPLE signals: large network size ≫ tiny text,
 *  a generic title, AND no content-bearing JSON-LD (any CONTENT_TITLE_TYPE = real structured content). */
function detectLowValue(result: Result): boolean {
  if (result.result.trim().length >= LOW_VALUE_MAX_TEXT) return false;
  // For a promoted Tier-3 result `bytes` is the rendered DOM size; `egressBytes` is the network size
  // (the SPA's JS/CSS) — the real "large page" signal. A large SPA with a tiny DOM ("Careers") has
  // small `bytes` but large `egressBytes`, so the threshold must use the network size (#159 codex).
  if ((result.egressBytes ?? result.bytes) < LOW_VALUE_MIN_BYTES) return false;
  if (!GENERIC_TITLES.has((result.title ?? "").trim().toLowerCase())) return false;
  return !primaryTypes(result.structured?.jsonLd).some((t) => CONTENT_TITLE_TYPES.has(t));
}

/** Classify content quality: "app_error" (demote) or "low_value" (warn). undefined = normal. App-error
 *  takes precedence (it is not real content). A failed fetch (tier:error) or an anti-bot challenge
 *  (challengeProvider) is already gated/not-content — not "low-quality content". */
export function classifyContentQuality(result: Result): ContentQuality | undefined {
  if (result.tier === "error" || result.challengeProvider) return undefined;
  if (detectAppError(result)) return "app_error";
  if (detectLowValue(result)) return "low_value";
  return undefined;
}

/** Stamp the content-quality verdict onto a resolved Result (#145/#150): set `contentQuality` and
 *  surface the right advisory. App-error DEMOTES to a failed fetch (the crash screen is not usable
 *  content — the body stays in result.result; applyOutputMode returns it raw, no transform). Low-value
 *  is a non-fatal warning (status partial). No-op when the content is normal. */
export function stampContentQuality(result: Result): void {
  const quality = classifyContentQuality(result);
  if (!quality) return;
  result.contentQuality = quality;
  if (quality === "app_error") {
    result.tier = "error";
    result.errors.push({ code: "render_app_error", message: "Rendered page is a client-app error boundary (e.g. \"Something went wrong\"), not content." });
  } else {
    result.errors.push({ code: "low_value_extraction", message: "Page returned HTTP success but near-empty useful content (thin extraction) — may be a shell or behind JS." });
  }
}

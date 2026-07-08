// Content-quality detection for a successful fetch whose bytes aren't real/usable content.
// Two conservative, HIGH-PRECISION detectors behind one `Result.contentQuality` field (#145/#150):
//   - "app_error": a client-app error-boundary screen (HTTP 200, non-empty error text like
//     "Something went wrong") promoted as content → demoted to tier:error (#145).
//   - "low_value": HTTP success but near-empty useful content (thin extraction, e.g. just
//     "Careers") → a non-fatal warning, status partial (#150).
// Conservative by design: each requires multiple strong signals so a legitimate short/generic
// page is not false-positive'd. Better to miss a thin page than to mislabel real content.
import type { Result } from "../domain/result.ts";
import { classifyContentType } from "./classify.ts";

export type ContentQuality = "app_error" | "low_value";

/** Known client-app error-boundary signatures (#145) — matched against a SHORT extracted result
 *  (the error screen IS the page content). Curated, vendor-specific phrases, not generic words. */
const APP_ERROR_SIGNATURES = [
  "something went wrong",
  "application error: a client-side exception",
  "a critical error occurred",
];
/** A real article discussing errors would be longer; only a short result that IS the error screen. */
const APP_ERROR_MAX_CHARS = 300;
/** Titles that signal "this is a shell/landing, not the page's real subject". */
const GENERIC_TITLES = new Set(["careers", "career", "home", "loading", "untitled", ""]);
/** Low-value requires the page to be large but text-poor (bytes ≫ extracted text). */
const LOW_VALUE_MAX_TEXT = 500;
const LOW_VALUE_MIN_BYTES = 100_000;

/** A client-app crash into its error boundary (#145): the rendered "Something went wrong" screen
 *  was promoted as content. Detected by a short result matching a known crash signature. */
function detectAppError(result: Result): boolean {
  const text = result.result.toLowerCase();
  return text.length <= APP_ERROR_MAX_CHARS && APP_ERROR_SIGNATURES.some((sig) => text.includes(sig));
}

/** A page that returned HTTP success but near-empty useful content (#150) — e.g. a rendered SPA
 *  whose visible text is just "Careers". Requires MULTIPLE signals: large bytes ≫ tiny text, a
 *  generic title, AND no content-bearing JSON-LD (a JobPosting/Product/Article means real content). */
function detectLowValue(result: Result): boolean {
  if (result.result.trim().length >= LOW_VALUE_MAX_TEXT) return false;
  if (result.bytes < LOW_VALUE_MIN_BYTES) return false;
  if (!GENERIC_TITLES.has((result.title ?? "").trim().toLowerCase())) return false;
  const ct = classifyContentType(result);
  return ct !== "job" && ct !== "product" && ct !== "article";
}

/** Classify content quality: "app_error" (demote) or "low_value" (warn). undefined = normal.
 *  App-error takes precedence (it is not real content at all). A failed fetch (tier:error) is not
 *  "low-quality content" — it's already a failure. */
export function classifyContentQuality(result: Result): ContentQuality | undefined {
  if (result.tier === "error") return undefined;
  if (detectAppError(result)) return "app_error";
  if (detectLowValue(result)) return "low_value";
  return undefined;
}

/** Stamp the content-quality verdict onto a resolved Result (#145/#150): set `contentQuality` and
 *  surface the right advisory. App-error DEMOTES to a failed fetch (the crash screen is not usable
 *  content — the body stays in result.result for the agent to read). Low-value is a non-fatal
 *  warning (status partial). No-op when the content is normal. */
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

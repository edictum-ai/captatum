// Content-quality detection for a successful fetch whose bytes aren't real/usable content.
// Two conservative, HIGH-PRECISION detectors behind one `Result.contentQuality` field (#145/#150):
//   - "app_error": a RENDERED client-app error-boundary screen (HTTP 200, the crash text IS the
//     page content) → demoted to tier:error (#145).
//   - "low_value": HTTP success but near-empty useful content (thin extraction, e.g. "Careers")
//     → a non-fatal warning, status partial (#150).
// Conservative by design: each requires multiple strong signals so a legitimate page is not
// false-positive'd. Better to miss a thin page than to mislabel real content.
import type { Result } from "../domain/result.ts";
import { hasContentBearingJsonLd } from "../domain/content-bearing.ts";
import { isPinDetailPage } from "../domain/pin-url.ts";

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

/** A page that returned HTTP success but near-empty useful content (#150) — e.g. a rendered SPA whose
 *  visible text is just "Careers", or a non-English job board whose static HTML is chrome-only. Requires
 *  MULTIPLE signals: large network size ≫ tiny text AND no content-bearing JSON-LD. The English-only title
 *  gate that was here was dropped (#179): post-#152 hasContentBearingJsonLd is a strict data-@type allowlist,
 *  so the no-content-bearing signal is strong on its own and the title was the sole recall blocker for
 *  non-English/branded titles (StartupJobs' Czech title). `low_value` judges TEXT-extraction quality — a
 *  map/video/canvas page with thin chrome is low_value for text (non-fatal: images[] for vision, JSON-LD
 *  via raw); NOT exempted by a metadata @type (VideoObject) — that would diverge from the shared predicate
 *  (#159 drift). */
function detectLowValue(result: Result): boolean {
  if (result.result.trim().length >= LOW_VALUE_MAX_TEXT) return false;
  // For a promoted Tier-3 result `bytes` is the rendered DOM size; `egressBytes` is the network size
  // (the SPA's JS/CSS) — the real "large page" signal. A large SPA with a tiny DOM ("Careers") has
  // small `bytes` but large `egressBytes`, so the threshold must use the network size (#159 codex).
  if ((result.egressBytes ?? result.bytes) < LOW_VALUE_MIN_BYTES) return false;
  // Reuse the shell-gate's JSON-LD content-bearing predicate — INTENTIONALLY NOT its app-state predicate.
  // The gate treats a named app-state key (__NEXT_DATA__/__NUXT_DATA__/…) as "maybe content" to ELIDE a
  // render (a latency heuristic); but appState is NOT surfaced in the lean receipt (debug-gated), so a
  // tier-1 app-state page with thin visible text still DELIVERS thin content to the agent. low_value
  // judges the delivered text, so it does not mirror the gate's app-state signal — else the StartupJobs
  // repro (Nuxt shell, 68 chars visible, __NUXT_DATA__ present) would silently pass again (#185 codex P2
  // declined on this rationale; the deeper fix is shell-gate/render fidelity, #152/#154).
  return !hasContentBearingJsonLd(result.structured?.jsonLd, isPinDetailPage(result.finalUrl || result.url));
}

/** Classify content quality: "app_error" (demote) or "low_value" (warn). undefined = normal. App-error
 *  takes precedence (it is not real content). Only for SUCCESSFUL CONTENT fetches — tier 1/2/3. A failed
 *  fetch is already status:fail (not "low-quality content"): that includes tier:"error", the render-incapable
 *  tiers (render-unavailable/render-blocked — content was not obtained, and prescribing "re-fetch with render"
 *  would be impossible on a no-browser flavor or contradict an allowRender:false caller), an anti-bot
 *  challenge, or a 4xx/5xx HTTP error. Positively requiring a content tier auto-excludes any future failure
 *  tier too (#179 review). */
export function classifyContentQuality(result: Result): ContentQuality | undefined {
  const contentTier = result.tier === 1 || result.tier === 2 || result.tier === 3;
  if (!contentTier || result.challengeProvider || result.botVerification || Number(result.code) >= 400) return undefined;
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
    result.errors.push({ code: "low_value_extraction", message: lowValueMessage(result) });
  }
}

/** Tier-aware low_value advisory (#179): the verdict judges TEXT-extraction quality, so the message must
 *  not over-claim "shell or behind JS" (wrong for a rendered map/video/canvas page) and must not PRESCRIBE
 *  an action impossible on some flavors (a re-fetch with render is unavailable on the no-browser binary).
 *  Describe likely causes instead — tier 1: the content may not have been reachable; tier 3 (rendered): the
 *  content may be non-textual, chrome-only, or the render may not have settled (the #110/#154 fidelity
 *  class), with surfaced images pointed to for an optional vision fetch. */
function lowValueMessage(result: Result): string {
  const textLen = result.result.trim().length;
  if (result.tier === 3) {
    const images = result.structured?.images?.length ?? 0;
    const vision = images > 0 ? `; ${images} image(s) surfaced for an optional vision fetch` : "";
    return `Rendered but the text extraction is thin (${textLen} chars) — content may be non-textual (map/video/canvas), chrome-only, behind login, or the render may not have settled${vision}.`;
  }
  return `HTTP success but the text extraction is thin (${textLen} chars) — the page may be a JS shell, behind login/consent, or a non-text app (the main content may not have been reachable).`;
}

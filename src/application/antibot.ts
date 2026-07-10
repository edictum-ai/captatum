import type { AntiBotEvidence, FetcherResult } from "./ports/fetcher.ts";
import type { Result } from "../domain/result.ts";

export interface AntiBotSignal {
  signal: string;
}

/**
 * Conservative, vendor-attributed anti-bot-block detection (#41 Half A + #151). Returns the
 * signal if the Tier-1 fetch hit a bot-protection challenge wall — so the result is reported as
 * `gated` (`gateReason: "captcha"` or `"bot_verification"`) instead of the challenge HTML being
 * silently passed as page content. Returns null otherwise.
 *
 * Fires ONLY on vendor-SPECIFIC signals: the `cf-mitigated` header, a challenge-only body marker
 * unique to a challenge page (Cloudflare `cdn-cgi/challenge-platform` / `__cf_chl`, Akamai `_abck`,
 * PerimeterX `_px`, DataDome `captcha-delivery`, Imperva `Incapsula incident ID`), OR — distinct
 * (#151) — a generic browser-verification phrase (`verifying your browser`, …) gated on 429/503
 * + a non-JSON body. The vendor signals are status-INDEPENDENT; the phrase signal is status-gated
 * (the FP control). These do NOT include bare vendor names (`js.datadome.co/tags.js`) or generic
 * phrases at 200 — so an ordinary Cloudflare/DataDome/Imperva-fronted page that PASSED is NOT
 * flagged, nor is a JSON API error (#44-class FP control).
 *
 * The vendor signals are checked BEFORE the phrase so a wall with BOTH a vendor marker and a
 * verification phrase classifies as `captcha` (provider named), not `bot_verification`.
 *
 * NOTE (#41 Half B, not built): actually *bypassing* the challenge is not viable for captatum
 * (see docs/specs/issue-41-design.md + the evasion research). This detector only labels it.
 */
export function detectAntibotBlock(fetched: FetcherResult): AntiBotSignal | null {
  const e = fetched.antibot;
  if (!e) return null;
  if (e.hasCfMitigated) return { signal: "cf-mitigated" };
  if (e.hasChallengeBody) return { signal: "challenge-body" };
  if (e.hasVerificationPhrase) return { signal: "verification-phrase" };
  return null;
}

/** The challenge vendor for a detected anti-bot block (#41 Half A provenance; #151 adds
 *  datadome/imperva body-marker attribution — a body marker, not a forgeable server header). */
export function challengeProvider(e: AntiBotEvidence): string {
  if (e.hasDataDomeBody) return "datadome";
  if (e.hasImpervaBody) return "imperva";
  if (e.hasCfMitigated || e.hasCfRay || e.serverVendor === "cloudflare") return "cloudflare";
  if (e.serverVendor === "akamai") return "akamai";
  if (e.serverVendor === "perimeterx") return "perimeterx";
  if (e.serverVendor === "incapsula" || e.serverVendor === "imperva") return "imperva";
  return e.serverVendor !== "none" ? e.serverVendor : "unknown";
}

/** #41/#151: if the fetch hit an anti-bot challenge wall, stamp `base` as gated and return true
 *  so the caller skips the (futile) render/transform. For a vendor-attributed challenge sets
 *  `challengeProvider` (gateReason "captcha"); for a generic verification-phrase wall sets
 *  `botVerification` (gateReason "bot_verification", vendor unknown). The two are mutually
 *  exclusive — `detectAntibotBlock` returns one signal. */
export function stampAntibotChallenge(base: Result, fetched: FetcherResult): boolean {
  const sig = detectAntibotBlock(fetched);
  if (!sig || !fetched.antibot) return false;
  if (sig.signal === "verification-phrase") {
    base.botVerification = true;
    base.errors.push({
      code: "antibot_challenge",
      message: "browser-verification wall — fetched bytes are a bot-protection interstitial, not page content (#151).",
    });
    return true;
  }
  base.challengeProvider = challengeProvider(fetched.antibot);
  base.errors.push({
    code: "antibot_challenge",
    message: `${base.challengeProvider} anti-bot challenge — fetched bytes are a bot-protection interstitial, not page content (#41).`,
  });
  return true;
}

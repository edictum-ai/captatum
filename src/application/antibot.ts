import type { AntiBotEvidence, FetcherResult } from "./ports/fetcher.ts";
import type { Result } from "../domain/result.ts";

export interface AntiBotSignal {
  signal: string;
}

/**
 * Conservative, vendor-attributed anti-bot-block detection (#41 Half A). Returns
 * the signal if the Tier-1 fetch hit a bot-protection challenge wall — so the
 * result is reported as `gated` (`gateReason: "captcha"`) instead of the challenge
 * HTML being silently passed as page content. Returns null otherwise.
 *
 * Fires ONLY on vendor-SPECIFIC signals: the `cf-mitigated` header, or a body
 * marker unique to a challenge page (Cloudflare `cdn-cgi/challenge-platform` /
 * `__cf_chl`, Akamai `_abck`, PerimeterX `_px`). These are status-INDEPENDENT (a
 * challenge interstitial can be served at 200) and do NOT include generic phrases
 * ("Just a moment") or cookies alone (`__cf_bm` is set on ordinary Cloudflare-served
 * pages) — so an ordinary Cloudflare-fronted 403/503, an auth wall, or an empty 4xx
 * is NOT flagged (no #44-class false-positive).
 *
 * NOTE (#41 Half B, not built): actually *bypassing* the challenge is not viable
 * for captatum — see docs/specs/issue-41-design.md + the evasion research
 * (datacenter-ASN wall + OSS-stealth treadmill). This detector only labels it.
 */
export function detectAntibotBlock(fetched: FetcherResult): AntiBotSignal | null {
  const e = fetched.antibot;
  if (!e) return null;
  if (e.hasCfMitigated) return { signal: "cf-mitigated" };
  if (e.hasChallengeBody) return { signal: "challenge-body" };
  return null;
}

/** The challenge vendor for a detected anti-bot block (#41 Half A provenance). */
export function challengeProvider(e: AntiBotEvidence): string {
  if (e.hasCfMitigated || e.hasCfRay || e.serverVendor === "cloudflare") return "cloudflare";
  if (e.serverVendor === "akamai") return "akamai";
  if (e.serverVendor === "perimeterx") return "perimeterx";
  if (e.serverVendor === "incapsula" || e.serverVendor === "imperva") return "imperva";
  return e.serverVendor !== "none" ? e.serverVendor : "unknown";
}

/** #41 Half A: if the fetch hit an anti-bot challenge wall, stamp `base` as gated
 *  (challengeProvider + an `antibot_challenge` provenance error). Returns true when
 *  the result IS a challenge wall so the caller skips the (futile) render/transform. */
export function stampAntibotChallenge(base: Result, fetched: FetcherResult): boolean {
  if (!detectAntibotBlock(fetched) || !fetched.antibot) return false;
  base.challengeProvider = challengeProvider(fetched.antibot);
  base.errors.push({
    code: "antibot_challenge",
    message: `${base.challengeProvider} anti-bot challenge — fetched bytes are a bot-protection interstitial, not page content (#41).`,
  });
  return true;
}

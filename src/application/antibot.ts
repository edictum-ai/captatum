import type { AntiBotEvidence, FetcherResult } from "./ports/fetcher.ts";
import type { Result } from "../domain/result.ts";

/** Statuses associated with an anti-bot challenge. A 200 with a challenge body is a
 *  known false-negative this detector does not chase (#41 honest scope). */
const ANTIBOT_STATUS = new Set([403, 429, 503]);

export interface AntiBotSignal {
  signal: string;
}

/**
 * Conservative, vendor-attributed anti-bot-block detection (#41 Half A). Returns
 * the signal if the Tier-1 fetch hit a bot-protection challenge wall — so the
 * result is reported as `gated` (`gateReason: "captcha"`) instead of the challenge
 * HTML being silently passed as page content. Returns null otherwise.
 *
 * Requires a VENDOR-ATTRIBUTED signal: `cf-mitigated`, a Cloudflare/Akamai/PX
 * challenge body, or a vendor challenge cookie paired with vendor attribution
 * (`server`/`cf-ray`). NOT a forgeable `Server: cloudflare` header alone, and NOT
 * a generic "enable javascript" body phrase. So an ordinary 403 (auth wall), 503
 * (service unavailable), or empty 4xx is NOT flagged as a challenge.
 *
 * NOTE (#41 Half B, not built): actually *bypassing* the challenge is not viable
 * for captatum — see docs/specs/issue-41-design.md + the evasion research
 * (datacenter-ASN wall + OSS-stealth treadmill). This detector only labels it.
 */
export function detectAntibotBlock(fetched: FetcherResult): AntiBotSignal | null {
  const e = fetched.antibot;
  if (!e || !ANTIBOT_STATUS.has(e.status)) return null;
  // Strong, vendor-attributed body/header signals:
  if (e.hasCfMitigated) return { signal: "cf-mitigated" };
  if (e.hasChallengeBody) return { signal: "challenge-body" };
  // Vendor cookie requires vendor attribution (a bare cookie is not enough):
  if (e.hasChallengeCookie && (e.hasCfRay || e.serverVendor !== "none")) {
    return { signal: `${e.serverVendor}-challenge-cookie` };
  }
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

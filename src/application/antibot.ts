import type { FetcherResult } from "./ports/fetcher.ts";

/** Statuses associated with an anti-bot challenge. A 200 with a challenge body is a
 *  known false-negative this detector does not chase (#41 honest scope). */
const ANTIBOT_STATUS = new Set([403, 429, 503]);

export interface AntiBotSignal {
  signal: string;
}

/**
 * Conservative, vendor-attributed anti-bot-block detection (#41). Returns the
 * signal if the Tier-1 fetch was anti-bot-blocked — worth retrying the fetch
 * through the Tier-3 browser — or null otherwise.
 *
 * Requires a VENDOR-ATTRIBUTED signal: `cf-mitigated`, a Cloudflare/Akamai/PX
 * challenge body, or a vendor challenge cookie paired with vendor attribution
 * (`server`/`cf-ray`). NOT a forgeable `Server: cloudflare` header alone, and NOT
 * a generic "enable javascript" body phrase. So an ordinary 403 (auth wall), 503
 * (service unavailable), or empty 4xx does NOT trigger a browser spawn.
 *
 * The detector is nonetheless an amplification surface — an attacker target can
 * serve vendor signals to force Chromium spawns. The per-task rate limit + the
 * server kill-switch are the DoS backstop, not this predicate.
 * See docs/specs/issue-41-design.md.
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

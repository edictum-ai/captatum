export interface FetcherOptions {
  /** Decompressed response byte cap. */
  maxBytes: number;
  /** Per-tier wall-clock timeout. */
  timeoutMs: number;
  /** Maximum redirect hops, each re-validated against SSRF guards. */
  maxHops: number;
}

export interface Redirect {
  url: string;
  status: number;
}

/**
 * Curated, vendor-attributed anti-bot evidence extracted from a fetch response.
 * Computed in the guarded fetcher (where response headers + the buffered body
 * live) and exposed as booleans/enums ONLY — never a raw header bag — so
 * attacker-controlled header strings do not reach the application layer (#41).
 * Consumed by `detectAntibotBlock` to decide whether to retry the fetch through
 * the Tier-3 browser. See docs/specs/issue-41-design.md.
 */
export interface AntiBotEvidence {
  /** The response status (the detector requires an anti-bot-associated code). */
  status: number;
  /** `server` header vendor, if attributable. Forgeable — a weak signal alone. */
  serverVendor: "cloudflare" | "akamai" | "imperva" | "incapsula" | "perimeterx" | "none";
  /** `cf-mitigated` response header present (Cloudflare, strong). */
  hasCfMitigated: boolean;
  /** `cf-ray` response header present (Cloudflare edge). */
  hasCfRay: boolean;
  /** A vendor challenge cookie was set (`__cf_bm`, `datadome`, `_px`, …). */
  hasChallengeCookie: boolean;
  /** The body head matches a VENDOR-SPECIFIC challenge marker (Cloudflare
   *  challenge-platform / `__cf_chl` / "Just a moment", Akamai sensor, …) — not a
   *  generic "enable javascript" phrase. */
  hasChallengeBody: boolean;
}

export interface FetcherResult {
  status: number;
  finalUrl: string;
  redirects: Redirect[];
  bodyStream: ReadableStream<Uint8Array>;
  contentType: string;
  bytes: number;
  truncated?: boolean;
  /** Vendor-attributed anti-bot evidence (#41). Absent on rejects/non-HTTP paths. */
  antibot?: AntiBotEvidence;
}

export interface RejectResult {
  rejected: true;
  code: string;
  message: string;
}

/**
 * The single hardened egress primitive. Every outbound request — Tier-1,
 * Tier-2 adapters, every redirect hop, every Tier-3 in-browser request —
 * routes through this port so SSRF guards are enforced uniformly.
 *
 * See docs/contracts.md "Security controls".
 */
export interface FetcherPort {
  fetchGuarded(
    url: string,
    opts: FetcherOptions,
  ): Promise<FetcherResult | RejectResult>;
}

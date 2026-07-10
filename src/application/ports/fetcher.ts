export interface FetcherOptions {
  /** Decompressed response byte cap. */
  maxBytes: number;
  /** Per-tier wall-clock timeout. */
  timeoutMs: number;
  /** Maximum redirect hops, each re-validated against SSRF guards. */
  maxHops: number;
  /** Optional external abort signal (e.g. the `captatum_bulk` wall deadline). When
   *  present, the guarded fetcher composes it with its own per-tier timeout
   *  controller via `AbortSignal.any`, so EITHER firing aborts the in-flight
   *  request (surfaced as a `code:"timeout"` reject, same as a per-tier timeout).
   *  Additive + optional: single-fetch callers omit it and behavior is unchanged. */
  signal?: AbortSignal;
}

/**
 * Optional non-GET request descriptor — a SEPARATE argument rather than a field on
 * FetcherOptions so the (shared, immutable) opts can never carry a method/body that
 * leaks across requests. Today only POST is supported (#111): a Tier-3 in-browser POST
 * the route gate has authorized as first-party is forwarded through FetcherPort with the
 * body bytes + an allowlisted Content-Type. `method`/`body` apply to the INITIAL request
 * only — `fetchWithRedirects` reverts to GET + no body on any 3xx (incl. 307/308) so the
 * body never reaches a redirect target (SSRF/data-leak guard).
 */
export interface PostInit {
  method: "POST";
  body: Uint8Array;
  requestContentType?: string;
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
   *  challenge-platform / `__cf_chl`, Akamai sensor, DataDome `captcha-delivery`,
   *  Imperva `Incapsula incident ID`, …) — not a generic "enable javascript" phrase
   *  and not a bare vendor name (the SDK tag, which appears on every protected page). */
  hasChallengeBody: boolean;
  /** The body head matches the DataDome challenge-delivery marker (`captcha-delivery`).
   *  Drives `challengeProvider:"datadome"` attribution (a body marker, not a forgeable
   *  server header). #151. */
  hasDataDomeBody: boolean;
  /** The body head matches the Imperva/Incapsula block-page marker
   *  (`Incapsula incident ID` / `Powered By Incapsula`). Drives
   *  `challengeProvider:"imperva"` attribution. #151. */
  hasImpervaBody: boolean;
  /** A generic browser-verification phrase (`verifying your browser`, …) in the body
   *  head, gated on status 429/503 AND a non-JSON content type (the FP controls — a 200
   *  page or a JSON API error with the phrase is NOT gated). Drives
   *  `gateReason:"bot_verification"` (vendor not attributable). #151. */
  hasVerificationPhrase: boolean;
}

export interface FetcherResult {
  status: number;
  finalUrl: string;
  redirects: Redirect[];
  bodyStream: ReadableStream<Uint8Array>;
  contentType: string;
  bytes: number;
  truncated?: boolean;
  /** Why the body was truncated: `"cap"` = it exceeded `maxBytes` (a clean prefix of a
   *  larger body); `"body_read_error"` = the stream broke mid-read AFTER partial bytes
   *  arrived (premature close / Content-Length mismatch / decompression truncation) —
   *  transport-unreliable, but partial content > none (#149). Absent when not truncated. */
  truncatedReason?: "cap" | "body_read_error";
  /** Vendor-attributed anti-bot evidence (#41). Absent on rejects/non-HTTP paths. */
  antibot?: AntiBotEvidence;
  /** Curated `Retry-After` (ms) parsed from the response header on a 429/503
   *  (seconds or HTTP-date). Absent when there is no usable Retry-After or the
   *  status is not 429/503. Surfaced to the caller (no auto-retry in the fetcher)
   *  so the bulk orchestrator can perform one jittered retry (PR 3). */
  retryAfterMs?: number;
}

export interface RejectResult {
  rejected: true;
  code: string;
  message: string;
  /** Redirect chain followed before the reject (e.g. a 302 to a host that then timed out or
   *  was SSRF-rejected). Carried so the orchestrator can count redirect-funnel victims even
   *  when the final hop failed (directed-DoS accounting). Absent/empty when the reject happened
   *  before any redirect (e.g. a private-address literal at initial resolve). */
  redirects?: Redirect[];
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
    postInit?: PostInit,
  ): Promise<FetcherResult | RejectResult>;
}

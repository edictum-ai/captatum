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

export interface FetcherResult {
  status: number;
  finalUrl: string;
  redirects: Redirect[];
  bodyStream: ReadableStream<Uint8Array>;
  contentType: string;
  bytes: number;
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

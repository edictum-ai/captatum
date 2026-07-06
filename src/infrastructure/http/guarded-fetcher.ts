import type {
  AntiBotEvidence,
  FetcherOptions,
  FetcherPort,
  FetcherResult,
  PostInit,
  Redirect,
  RejectResult,
} from "../../application/ports/fetcher.ts";
import { readCappedBody, streamFromBytes } from "./body.ts";
import { type DnsResolver, NodeDnsResolver, resolvePublicAddress } from "./dns.ts";
import { reject, throwIfAborted, toRejectResult, withAbort } from "./errors.ts";
import { type HttpRequester, NodeHttpRequester, BLOCKED_PORTS } from "./request.ts";
import {
  headerValue,
  isRedirectStatus,
  normalizeInitialUrl,
  normalizeRedirectUrl,
  type NormalizedUrl,
} from "./url.ts";

export interface GuardedHttpFetcherDeps {
  resolver?: DnsResolver;
  requester?: HttpRequester;
}

export class GuardedHttpFetcher implements FetcherPort {
  private readonly resolver: DnsResolver;
  private readonly requester: HttpRequester;

  constructor(deps: GuardedHttpFetcherDeps = {}) {
    this.resolver = deps.resolver ?? new NodeDnsResolver();
    this.requester = deps.requester ?? new NodeHttpRequester();
  }

  async fetchGuarded(url: string, opts: FetcherOptions, postInit?: PostInit): Promise<FetcherResult | RejectResult> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // Hoisted into fetchGuarded's scope so a reject (private redirect target, timeout mid-chain,
    // network error) carries the redirect chain in the RejectResult — the bulk orchestrator
    // counts redirect-funnel victims even when the final hop failed (directed-DoS accounting).
    const redirects: Redirect[] = [];

    try {
      const timeoutMs = positive(opts.timeoutMs, "timeout");
      timeout = setTimeout(() => controller.abort(), timeoutMs);
      // Compose the caller-supplied signal (e.g. the captatum_bulk wall deadline)
      // with this fetch's own per-tier timeout controller, so EITHER firing aborts
      // the in-flight request. The composed signal flows through throwIfAborted /
      // withAbort / resolvePublicAddress exactly like the per-tier timeout, so an
      // external abort surfaces as the same `code:"timeout"` reject. AbortSignal.any
      // is already-aborted if `opts.signal` is, and throwIfAborted handles that on
      // the next line of fetchWithRedirects. Omitted → falls back to the timeout
      // controller alone (single-fetch behavior, unchanged).
      const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;
      return await this.fetchWithRedirects(
        normalizeInitialUrl(url),
        opts,
        timeoutMs,
        signal,
        postInit,
        redirects,
      );
    } catch (error) {
      return toRejectResult(error, redirects);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async fetchWithRedirects(
    initial: NormalizedUrl,
    opts: FetcherOptions,
    timeoutMs: number,
    signal: AbortSignal,
    postInit: PostInit | undefined,
    redirects: Redirect[],
  ): Promise<FetcherResult> {
    const maxBytes = positive(opts.maxBytes, "maxBytes");
    const maxHops = nonNegative(opts.maxHops, "maxHops");
    let current = initial;

    for (;;) {
      throwIfAborted(signal);
      // method/body apply to the INITIAL request only. On ANY redirect hop (incl. 307/308,
      // which RFC 7231 preserves) we revert to GET + no body — a deliberate, mandatory
      // deviation so the page-authored POST body can never reach a redirect target host
      // (SSRF/data-leak guard). `redirects.length === 0` exactly identifies the initial
      // request because redirects is pushed AFTER the 3xx is processed below.
      const response = await this.requestValidated(current, timeoutMs, signal, redirects.length === 0 ? postInit : undefined);
      if (isRedirectStatus(response.status)) {
        const location = headerValue(response.headers, "location");
        if (!location) {
          return await this.finalResult(current, redirects, response, maxBytes, signal);
        }
        response.body.destroy();
        if (redirects.length >= maxHops) {
          reject("redirect_limit", "Redirect limit exceeded");
        }
        current = normalizeRedirectUrl(location, current.url);
        redirects.push({ url: current.finalUrl, status: response.status });
        continue;
      }
      return await this.finalResult(current, redirects, response, maxBytes, signal);
    }
  }

  private async requestValidated(
    current: NormalizedUrl,
    timeoutMs: number,
    signal: AbortSignal,
    postInit?: PostInit,
  ) {
    // SSRF-4: enforce the port denylist here (the single chokepoint), before
    // either requester (wreq-js HTTP or Node HTTPS fallback) is selected.
    const port = Number(current.url.port || (current.url.protocol === "https:" ? 443 : 80));
    if (BLOCKED_PORTS.has(port)) reject("blocked_port", `Port ${port} is a well-known non-HTTP service port`);
    const resolved = await resolvePublicAddress(current.hostname, this.resolver, signal);
    return await withAbort(
      this.requester.request({
        url: current.url,
        address: resolved.address,
        family: resolved.family,
        hostHeader: current.hostHeader,
        signal,
        timeoutMs,
        // postInit is undefined on every redirect hop (body-drop guard above); the IP-pinning
        // SSRF guard is method-agnostic — the body is just bytes on a guard-resolved connection.
        ...(postInit ? {
          method: postInit.method,
          body: postInit.body,
          requestContentType: postInit.requestContentType,
        } : {}),
      }),
      signal,
    );
  }

  private async finalResult(
    current: NormalizedUrl,
    redirects: Redirect[],
    response: Awaited<ReturnType<HttpRequester["request"]>>,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<FetcherResult> {
    const body = await readCappedBody(response.body, response.headers, maxBytes, signal);
    return {
      status: response.status,
      finalUrl: current.finalUrl,
      redirects,
      bodyStream: streamFromBytes(body.bytes),
      contentType: headerValue(response.headers, "content-type"),
      bytes: body.byteLength,
      ...(body.truncated ? { truncated: true } : {}),
      antibot: computeAntiBotEvidence(response.headers, body.bytes, response.status),
    };
  }
}

/** Vendor cookie prefixes set by anti-bot challenges (#41 detection). These
 *  cookies (e.g. `__cf_bm`) are also set on ordinary Cloudflare-served pages, so a
 *  cookie ALONE is NOT a challenge signal — detection requires a vendor-specific
 *  body marker or `cf-mitigated`. */
const CHALLENGE_COOKIE = /(?:^|,\s*)(?:__cf_bm|__cf_chl_|datadome|_px|incap_ses|visid_incap|nlbi_)=/i;
/** Vendor-SPECIFIC body markers — Cloudflare `cdn-cgi/challenge-platform` /
 *  `__cf_chl`, Akamai `_abck`, PerimeterX `_px`. NOT generic phrases like "Just a
 *  moment" (which can appear on a non-challenge page), so an ordinary page does not
 *  false-positive. Status-independent — a challenge interstitial can be served at 200. */
const CHALLENGE_BODY_MARKERS = /cdn-cgi\/challenge-platform|__cf_chl|cf-browser-verification|akamaighost|_abck|px-captcha|\/_px\//i;

/** Curated, vendor-attributed anti-bot evidence from the response. All fields are
 *  booleans/enums — the raw attacker-controlled headers/body never leave this
 *  function (the application layer only sees the verdict). See
 *  docs/specs/issue-41-design.md. */
function computeAntiBotEvidence(
  headers: Record<string, string | string[] | number | undefined>,
  body: Uint8Array,
  status: number,
): AntiBotEvidence {
  const server = headerValue(headers, "server").toLowerCase();
  const serverVendor: AntiBotEvidence["serverVendor"] =
    server.includes("cloudflare") ? "cloudflare"
      : server.includes("akamai") ? "akamai"
        : server.includes("incapsula") ? "incapsula"
          : server.includes("imperva") ? "imperva"
            : server.includes("perimeterx") ? "perimeterx"
              : "none";
  const setCookie = headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie.join("\n") : (setCookie ? String(setCookie) : "");
  const bodyHead = new TextDecoder("utf8", { fatal: false }).decode(body.subarray(0, 4096));
  return {
    status,
    serverVendor,
    hasCfMitigated: headerValue(headers, "cf-mitigated") !== "",
    hasCfRay: headerValue(headers, "cf-ray") !== "",
    hasChallengeCookie: CHALLENGE_COOKIE.test(cookies),
    hasChallengeBody: CHALLENGE_BODY_MARKERS.test(bodyHead),
  };
}

function positive(value: number, name: string): number {
  if (Number.isInteger(value) && value > 0) return value;
  reject("invalid_options", `${name} must be a positive integer`);
}

function nonNegative(value: number, name: string): number {
  if (Number.isInteger(value) && value >= 0) return value;
  reject("invalid_options", `${name} must be a non-negative integer`);
}

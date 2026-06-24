import type {
  FetcherOptions,
  FetcherPort,
  FetcherResult,
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

  async fetchGuarded(url: string, opts: FetcherOptions): Promise<FetcherResult | RejectResult> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeoutMs = positive(opts.timeoutMs, "timeout");
      timeout = setTimeout(() => controller.abort(), timeoutMs);
      return await this.fetchWithRedirects(
        normalizeInitialUrl(url),
        opts,
        timeoutMs,
        controller.signal,
      );
    } catch (error) {
      return toRejectResult(error);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async fetchWithRedirects(
    initial: NormalizedUrl,
    opts: FetcherOptions,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<FetcherResult> {
    const maxBytes = positive(opts.maxBytes, "maxBytes");
    const maxHops = nonNegative(opts.maxHops, "maxHops");
    const redirects: Redirect[] = [];
    let current = initial;

    for (;;) {
      throwIfAborted(signal);
      const response = await this.requestValidated(current, timeoutMs, signal);
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
    };
  }
}

function positive(value: number, name: string): number {
  if (Number.isInteger(value) && value > 0) return value;
  reject("invalid_options", `${name} must be a positive integer`);
}

function nonNegative(value: number, name: string): number {
  if (Number.isInteger(value) && value >= 0) return value;
  reject("invalid_options", `${name} must be a non-negative integer`);
}

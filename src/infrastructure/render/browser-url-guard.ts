import type { RejectResult } from "../../application/ports/fetcher.ts";
import { type DnsResolver, NodeDnsResolver, resolvePublicAddress } from "../http/dns.ts";
import { toRejectResult } from "../http/errors.ts";
import { normalizeInitialUrl } from "../http/url.ts";

export interface BrowserUrlGuard {
  check(url: string, signal: AbortSignal): Promise<RejectResult | null>;
}

export class P1BrowserUrlGuard implements BrowserUrlGuard {
  private readonly resolver: DnsResolver;

  constructor(resolver: DnsResolver = new NodeDnsResolver()) {
    this.resolver = resolver;
  }

  async check(url: string, signal: AbortSignal): Promise<RejectResult | null> {
    try {
      const normalized = normalizeInitialUrl(url);
      await resolvePublicAddress(normalized.hostname, this.resolver, signal);
      return null;
    } catch (error) {
      return toRejectResult(error);
    }
  }
}

export function safeRenderUrl(input: string): string {
  try {
    const url = new URL(input);
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    return url.href;
  } catch {
    return "";
  }
}

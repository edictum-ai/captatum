// RenderEgressHosts — tracks the registrable domains a Tier-3 render loaded
// subresources from (BULK-3). Extracted from RenderRouteState to respect the
// 250-line limit. One entry per host (Set dedup); the bulk orchestrator feeds the
// output into the per-host union count gate so a render-path directed victim is
// bounded by `maxPerHostInBulk`. The per-render VOLUME is bounded separately by
// RenderRouteState's byte pools (surfaced as `Result.egressBytes`, BULK-5).
import { registrableDomain } from "../../domain/registrable-domain.ts";
import { hostnameOf } from "./route-helpers.ts";

export class RenderEgressHosts {
  private readonly hosts = new Set<string>();

  /** Record a fulfilled subresource's host (registrable domain, bare-host
   *  fallback for IP/unknown — same rule as the orchestrator's union key). Called
   *  only on a real `route.fulfill` (confirmed egress), not on synthesized OPTIONS
   *  or pre-network aborts. */
  note(url: string): void {
    const h = hostnameOf(url);
    this.hosts.add(registrableDomain(h) ?? h);
  }

  /** Record the FULL egress chain of a fulfilled subresource: the requested URL +
   *  every redirect hop + the final URL. A subresource that 302s from a unique
   *  domain to a victim reaches the victim on the redirect — recording only the
   *  original URL would let a render-path redirect funnel evade the per-host cap
   *  (codex P2). */
  noteFulfilled(requestUrl: string, redirects: ReadonlyArray<{ url: string }>, finalUrl: string): void {
    this.note(requestUrl);
    for (const r of redirects) this.note(r.url);
    if (finalUrl) this.note(finalUrl);
  }

  get(): string[] {
    return [...this.hosts];
  }
}

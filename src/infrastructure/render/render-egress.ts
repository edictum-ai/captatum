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

  get(): string[] {
    return [...this.hosts];
  }
}

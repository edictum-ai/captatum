import { registrableDomain } from "../../domain/registrable-domain.ts";
import type { RenderDiagnostics } from "../../domain/result.ts";

/** Output-boundary sentinel for an IP-literal / single-label / unknown host (a host whose
 *  registrable domain is null). Never a raw IP crosses the output boundary. (#154 security pin) */
const IP_LITERAL_SENTINEL = "[ip-literal]";

/** Redact one egress host for OUTPUT: its registrable domain, or `[ip-literal]` when the host is
 *  an IP literal / single-label / unknown (`registrableDomain` returns null for those). The count
 *  is preserved (a map, not a filter) so the diagnostic stays honest about HOW MANY hosts loaded
 *  without leaking a raw public IP. The internal `render-egress.ts` `registrableDomain(h) ?? h`
 *  fallback is KEPT for the bulk union-key gate (it keys two IP subresources together); only the
 *  SURFACED copy is redacted, at the trust boundary. */
export function redactEgressHost(host: string): string {
  return registrableDomain(host) ?? IP_LITERAL_SENTINEL;
}

/** Shape RenderDiagnostics for output: every field is a count / size / enum, except
 *  `renderEgressHosts` which is redacted (registrable domain or [ip-literal]), DEDUPED, and
 *  CAPPED. The page chooses its own subresource hosts, so the set is attacker-influenced — a
 *  hostile render_empty page can fetch() arbitrary hosts (a covert channel / receipt bloat). The
 *  cap bounds the cardinality surfaced into the caller's context (#154 review HIGH). */
const MAX_SURFACED_RENDER_HOSTS = 8;

export function shapeRenderDiagnostics(d: RenderDiagnostics, includeHosts = true): Record<string, unknown> {
  const out: Record<string, unknown> = {
    blockedRequests: d.blockedRequests,
    forwardedRequests: d.forwardedRequests,
    possibleReason: d.possibleReason,
  };
  if (includeHosts) out.renderEgressHosts = capRenderEgressHosts(d.renderEgressHosts);
  if (d.renderedBytes !== undefined) out.renderedBytes = d.renderedBytes;
  if (d.domTextLength !== undefined) out.domTextLength = d.domTextLength;
  if (d.egressBytes !== undefined) out.egressBytes = d.egressBytes;
  return out;
}

/** Redact each host, dedup (collapse duplicate domains + the [ip-literal] sentinel — N distinct
 *  IPs surface as a single [ip-literal]), and cap the cardinality at MAX_SURFACED_RENDER_HOSTS
 *  (a trailing "(+K more)" count preserves the total without surfacing more page-chosen strings). */
function capRenderEgressHosts(hosts: string[]): string[] {
  const seen = new Set<string>();
  const dedup: string[] = [];
  for (const h of hosts) {
    const redacted = redactEgressHost(h);
    if (!seen.has(redacted)) {
      seen.add(redacted);
      dedup.push(redacted);
    }
  }
  if (dedup.length <= MAX_SURFACED_RENDER_HOSTS) return dedup;
  const omitted = dedup.length - (MAX_SURFACED_RENDER_HOSTS - 1);
  return [...dedup.slice(0, MAX_SURFACED_RENDER_HOSTS - 1), `(+${omitted} more)`];
}

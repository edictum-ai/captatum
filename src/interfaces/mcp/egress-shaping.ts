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
 *  `renderEgressHosts` which is redacted to registrable domains + the sentinel. */
export function shapeRenderDiagnostics(d: RenderDiagnostics): Record<string, unknown> {
  const out: Record<string, unknown> = {
    renderEgressHosts: d.renderEgressHosts.map(redactEgressHost),
    blockedRequests: d.blockedRequests,
    forwardedRequests: d.forwardedRequests,
    possibleReason: d.possibleReason,
  };
  if (d.renderedBytes !== undefined) out.renderedBytes = d.renderedBytes;
  if (d.domTextLength !== undefined) out.domTextLength = d.domTextLength;
  if (d.egressBytes !== undefined) out.egressBytes = d.egressBytes;
  return out;
}

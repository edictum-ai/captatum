// Registrable-domain (eTLD+1) helpers, PSL-aware. Pure domain policy — no infrastructure
// imports (only `node:net` + `psl`) — so this stays in `src/domain` per the DDD-lite rule.
//
// Used by the Tier-3 POST route gate (#111) to decide same-party: a first-party POST
// forwards only when the request host shares the page's registrable domain. Also the
// shared helper for the upcoming bulk feature's same-registrable scope + per-host keying.
//
// The library is `psl` (NOT `tldts`): tldts ships ICANN-only data and omits the PSL
// "private domains" section, so it collapses multi-tenant suffixes — `foo.github.io` and
// `bar.github.io` would both resolve to `github.io`, the exact cross-tenant SSRF bypass
// this gate exists to prevent. `psl` bundles the full PSL (private domains included), so
// `foo.github.io` !== `bar.github.io`. (Verified 2026-07-05.) PSL data freshness is a
// documented known risk (docs/threat-model.md) — a multi-tenant suffix added upstream
// after the pinned `psl` release is not yet recognized; bounded by the per-hop SSRF IP
// guard + no forwarded credentials + same-registrable scope.
import { isIP } from "node:net";
import { parse as pslParse } from "psl";

/** The registrable domain (eTLD+1) of a hostname, or null when it cannot be determined
 *  (an IP literal, a single-label/empty host, or a host the PSL cannot resolve). Multi-
 *  tenant suffixes are honored: `foo.github.io` and `bar.github.io` are DIFFERENT
 *  registrable domains. Expects a bare hostname (no protocol/port/path) — callers extract
 *  it via `new URL(url).hostname`. */
export function registrableDomain(host: string): string | null {
  const h = stripBrackets(host.trim().toLowerCase());
  if (h === "" || !h.includes(".")) return null; // empty or single-label (e.g. localhost)
  if (isIP(h) !== 0) return null; // IP literal — not a domain (psl mis-parses these)
  const parsed = pslParse(h);
  return "error" in parsed ? null : (parsed.domain ?? null);
}

/** True when two hostnames share a registrable domain. Fail-closed: returns false when
 *  EITHER operand has no registrable domain (`null !== null` by design), so a page on an
 *  IP literal or localhost is never treated as same-party with a sibling — the route gate
 *  then aborts the POST rather than forwarding page-authored bytes on an ambiguous match. */
export function isSameRegistrableDomain(a: string, b: string): boolean {
  const ra = registrableDomain(a);
  const rb = registrableDomain(b);
  return ra !== null && rb !== null && ra === rb;
}

function stripBrackets(h: string): string {
  // `new URL().hostname` includes brackets for IPv6 literals; psl/isIP want the bare form.
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

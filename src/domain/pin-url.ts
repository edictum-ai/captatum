// Pure Pinterest pin URL classification (#152). Lives in domain so both the application layer
// (classify.ts contentType) and the infrastructure layer (shell-gate.ts gate-scoping of
// SocialMediaPosting) can import it without a backward dependency. Pure — no infra imports.
// `export {}` first: this module has no import, and Node's TS type-stripper (amaro, used by
// `node --check`) needs the module signal BEFORE the regex literal below to strip the private
// helper's annotations (without it, amaro under-strips a non-exported typed fn after a regex).
export {};


/** A genuine Pinterest host label, anchored at the END of the hostname: pinterest.com,
 *  country domains (pinterest.co.uk, pinterest.fr, pinterest.com.au, …) and subdomains (www.).
 *  Any 2-letter ccTLD is accepted: an attacker who registers pinterest.<cc> controls that page
 *  end-to-end, so surfacing its bytes is not a cross-domain injection. 3+-letter lookalikes
 *  (pinterest.com.evil) and substring spoofs (xpinterest.com) do NOT match. Bounded alternatives. */
const PINTEREST_HOST = /(^|\.)pinterest\.(com|(?:com|co)\.[a-z]{2}|[a-z]{2})$/;

function hostname(url: string): string | undefined {
  try {
    // Lowercase + strip a trailing dot (the FQDN form "pinterest.com." is the same host).
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return undefined;
  }
}

/** A Pinterest/pin.it URL (any pin page: a pin, board, profile, …). */
export function isPinHost(url: string): boolean {
  const host = hostname(url);
  if (!host) return false;
  if (host === "pin.it" || host.endsWith(".pin.it")) return true;
  return PINTEREST_HOST.test(host);
}

/** A specific pin DETAIL page — a pinterest URL whose path is the pin route "/pin/<numeric-id>"
 *  (optionally under "/amp/"), or a pin.it short link. Stricter than isPinHost: a board slug
 *  "/alice/pin/" or a route "/pin/create/" is NOT a pin detail page. This is the scope boundary
 *  for SocialMediaPosting gate-satisfaction + the Pass-2 caption harvest (#152). */
export function isPinDetailPage(url: string): boolean {
  const host = hostname(url);
  if (!host) return false;
  if (host === "pin.it" || host.endsWith(".pin.it")) return true;
  if (!PINTEREST_HOST.test(host)) return false;
  try {
    return /^\/(?:amp\/)?pin\/\d+(?:\/|$)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

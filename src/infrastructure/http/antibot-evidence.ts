// Anti-bot challenge detection over an already-fetched response (#41 + #151). Extracted from
// guarded-fetcher.ts (the SSRF-critical egress file) so that file stays under the 250-line limit
// and the detection logic — a pure function of response headers/body/status — is co-located.
// This issues NO request and adds NO egress/SSRF surface: it inspects bytes already pulled through
// the sole guardedFetch egress. See docs/specs/151-antibot-bot-verification.md +
// docs/threat-model.md "Anti-bot challenge classification".
import type { AntiBotEvidence } from "../../application/ports/fetcher.ts";
import { headerValue } from "./url.ts";

/** Vendor cookie prefixes set by anti-bot challenges (#41). A cookie ALONE is not a signal — it is
 *  also set on ordinary Cloudflare-served pages; detection needs a body marker or `cf-mitigated`.
 *  Bounded by the requester's max-header-size (one `\s*` quantifier — linear). */
const CHALLENGE_COOKIE = /(?:^|,\s*)(?:__cf_bm|__cf_chl_|datadome|_px|incap_ses|visid_incap|nlbi_)=/i;
/** Vendor CHALLENGE-ONLY body markers (status-INDEPENDENT). Challenge-only SIGNATURES, never bare
 *  vendor names: the DataDome SDK tag (`js.datadome.co/tags.js`) and the Imperva inline
 *  `/_Incapsula_Resource` sensor ship on every PROTECTED page, so matching them would gate legitimate
 *  200 content (#44-class FP, #151 B1/H3). `captcha-delivery` = DataDome's challenge CDN (inlined in
 *  the challenge body, not a passing page's bodyHead); `Incapsula incident ID`/`Powered By Incapsula`
 *  = Imperva block-page text. */
const CF_AKAMAI_PX_MARKERS = /cdn-cgi\/challenge-platform|__cf_chl|cf-browser-verification|akamaighost|_abck|px-captcha|\/_px\//i;
const DATADOME_CHALLENGE = /captcha-delivery/i;
const IMPERVA_BLOCK = /incapsula incident id|powered by incapsula/i;
/** Any vendor challenge-only body marker (the OR of the three above). Exported for the frozen
 *  ReDoS-shape acceptance test (test/acceptance/151/redos.test.ts). */
export const CHALLENGE_BODY_MARKERS = new RegExp([CF_AKAMAI_PX_MARKERS.source, DATADOME_CHALLENGE.source, IMPERVA_BLOCK.source].join("|"), "i");
/** A generic browser-verification phrase (ReDoS-safe literal alternation). Gated on 429/503 AND
 *  non-JSON in `computeAntiBotEvidence` so a 200 page or a JSON API error is NOT gated (#151). */
export const VERIFICATION_PHRASES = /verifying your browser|checking your browser|verify you are a human/i;

/** application-local mirror of classify.ts isJsonContentType (no app-layer import). */
function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const primary = contentType.split(";")[0].trim().toLowerCase();
  return primary === "application/json" || primary.endsWith("+json");
}

/** Curated, vendor-attributed anti-bot evidence from the response — booleans/enums only (raw
 *  attacker-controlled headers/body never leave). Exported as the #151 acceptance-suite test seam. */
export function computeAntiBotEvidence(
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
  const hasDataDomeBody = DATADOME_CHALLENGE.test(bodyHead);
  const hasImpervaBody = IMPERVA_BLOCK.test(bodyHead);
  return {
    status,
    serverVendor,
    hasCfMitigated: headerValue(headers, "cf-mitigated") !== "",
    hasCfRay: headerValue(headers, "cf-ray") !== "",
    hasChallengeCookie: CHALLENGE_COOKIE.test(cookies),
    hasChallengeBody: hasDataDomeBody || hasImpervaBody || CF_AKAMAI_PX_MARKERS.test(bodyHead),
    hasDataDomeBody,
    hasImpervaBody,
    hasVerificationPhrase:
      (status === 429 || status === 503)
      && !isJsonContentType(headerValue(headers, "content-type"))
      && VERIFICATION_PHRASES.test(bodyHead),
  };
}

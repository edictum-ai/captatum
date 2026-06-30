/**
 * Curated ad / tracker domain blocklist — used for Tier-3 route blocking (the
 * browser never fetches ad/tracker subresources) and Tier-1 extract filtering
 * (URLs pointing at these hosts are stripped from transform content). Each entry
 * is an APEX domain whose sole or primary purpose is serving ads, web
 * analytics/telemetry, session replay, social-tracking pixels, audience
 * measurement, or recommendation widgets.
 *
 * Compiled from open-source blocklists (EasyList, EasyPrivacy, Peter Lowe's
 * adservers, AdGuard DNS/Spyware, Disconnect) and adversarially vetted to EXCLUDE
 * shared CDNs/SaaS (cloudfront/akamai/fastly/cloudflare/googleapis/…) and
 * apex-of-portal domains whose blocking breaks legitimate sites — facebook.com,
 * linkedin.com, t.co, redditstatic.com, pinterest.com, quora.com, yandex.ru, and
 * hostnames under those apexes. No proprietary dependency; one entry per OSS-list
 * confirmation. See docs/threat-model.md "Sensitive-content detection".
 *
 * Add a domain only if it is confirmable against one of the OSS lists above AND
 * blocking it cannot remove first-party content. Subdomains of a listed apex are
 * blocked automatically (suffix match in isAdTrackerHost).
 */
export const AD_TRACKER_HOSTS: ReadonlySet<string> = new Set([
  // --- Ad networks / exchanges / SSPs / DSPs / ad servers ---
  "2mdn.net",
  "3lift.com",
  "aaxads.com",
  "adform.net",
  "admob.com",
  "adnxs.com",
  "adsafeprotected.com",
  "adsrvr.org",
  "adroll.com",
  "amazon-adsystem.com",
  "bidr.io",
  "bidswitch.net",
  "bidvertiser.com",
  "casalemedia.com",
  "connatix.com",
  "contextweb.com",
  "criteo.com",
  "criteo.net",
  "doubleclick.net",
  "exoclick.com",
  "googleadservices.com",
  "googlesyndication.com",
  "googletagservices.com",
  "indexexchange.com",
  "lijit.com",
  "media.net",
  "mgid.com",
  "moatads.com",
  "nativo.com",
  "openx.net",
  "popcash.net",
  "propellerads.com",
  "pubmatic.com",
  "revcontent.com",
  "rtmark.net",
  "rubiconproject.com",
  "serving-sys.com",
  "sharethrough.com",
  "smartadserver.com",
  "sonobi.com",
  "sovrn.com",
  "taboola.com",
  "triplelift.com",
  "yieldmo.com",
  "zergnet.com",
  // --- Recommendation / native-ad widgets ---
  "content.ad",
  "outbrain.com",
  // --- Web / product analytics, session replay, tag management ---
  "amplitude.com",
  "atinternet.com",
  "chartbeat.com",
  "chartbeat.net",
  "clarity.ms",
  "clicktale.com",
  "contentsquare.net",
  "crazyegg.com",
  "fullstory.com",
  "google-analytics.com",
  "googletagmanager.com",
  "heapanalytics.com",
  "hotjar.com",
  "luckyorange.com",
  "matomo.cloud",
  "mixpanel.com",
  "mouseflow.com",
  "mparticle.com",
  "mxpnl.com",
  "omniture.com",
  "omtrdc.net",
  "2o7.net",
  "parsely.com",
  "segment.io",
  "smartlook.com",
  "snowplowanalytics.com",
  "statcounter.com",
  "tealiumiq.com",
  // --- Social-tracking pixels (apex of the pixel host, NOT the social platform) ---
  "adsymptotic.com",
  "facebook.net",
  "analytics.yahoo.com",
  // --- Audience measurement / DMP / identity / attribution ---
  "adscore.com",
  "appsflyer.com",
  "bkrtx.com",
  "bluecava.com",
  "bluekai.com",
  "branch.io",
  "cr-nielsen.com",
  "cxense.com",
  "demdex.net",
  "doubleverify.com",
  "eyeota.net",
  "gemius.pl",
  "imrworldwide.com",
  "krxd.net",
  "liadm.com",
  "quantcount.com",
  "quantserve.com",
  "rlcdn.com",
  "scorecardresearch.com",
  "tapad.com",
  "w55c.net",
  // --- Marketing / share-button widgets ---
  "addthis.com",
  "sumome.com",
]);

/** True if host (or any parent label) is a known ad/tracker apex. Walks parent
 *  suffixes so `stats.g.doubleclick.net` → `doubleclick.net` matches. The input is
 *  capped at 253 chars (the DNS name limit): a longer host is attacker noise, and
 *  capping it keeps the walk O(labels) — the old per-label re-slice was O(n²) on a
 *  pathologically long hostname, and this is called per-URL over untrusted fetched
 *  content (a CPU-DoS guard). A bare TLD is never matched. */
export function isAdTrackerHost(host: string): boolean {
  if (host.length > 253) return false;
  const h = host.toLowerCase().replace(/\.$/, "");
  if (AD_TRACKER_HOSTS.has(h)) return true;
  let from = h.indexOf(".");
  while (from !== -1) {
    if (AD_TRACKER_HOSTS.has(h.slice(from + 1))) return true;
    from = h.indexOf(".", from + 1);
  }
  return false;
}

/** True if `host` is first-party to `mainHost` — the same host, or either is a
 *  subdomain of the other (same registrable domain, approximated without a public
 *  suffix list). Used to exempt the fetched page's own URLs/resources from adblock
 *  so a blocklisted vendor apex that IS the requested page (amplitude.com, hotjar.com,
 *  …) still loads and its own links survive the Tier-1 strip. */
export function isFirstPartyHost(host: string, mainHost: string): boolean {
  if (!mainHost) return false;
  const h = host.toLowerCase();
  const m = mainHost.toLowerCase();
  return h === m || h.endsWith(`.${m}`) || m.endsWith(`.${h}`);
}

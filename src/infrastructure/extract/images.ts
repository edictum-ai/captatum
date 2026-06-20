import { ipVersion, isPrivate } from "../../domain/policy.ts";
import { findStartTags } from "./html.ts";

/**
 * Maximum number of image URLs surfaced. Bounded so a media-heavy page cannot
 * flood the agent payload (and the transform context) with hundreds of URLs.
 */
const MAX_IMAGES = 12;

/**
 * Cap on how many `<img>`/`<source>` start tags are scanned. Bounds the O(N)
 * scan/alloc cost on a page with hundreds of thousands of tags (DoS hygiene)
 * while remaining far above any real page's image count.
 */
const MAX_MARKUP_SCAN = 200;

/** Per-URL length cap — rejects absurd URLs used only to bloat the payload. */
const MAX_URL_LENGTH = 2048;

const OG_IMAGE_KEYS = ["og:image", "og:image:url", "og:image:secure_url"];

/**
 * Cloud instance-metadata hostnames reachable BY NAME (no DNS needed). The real
 * egress guard (dns.ts) defeats these by resolving to 169.254.169.254 → isPrivate,
 * but images bypass DNS (never fetched), so the names must be matched here too.
 */
const METADATA_HOSTS = new Set([
  "metadata.google.internal", // GCP
  "metadata.aws.internal", // AWS (also 169.254.169.254 by IP, caught by isPrivate)
]);

/**
 * Collect absolute, deduped, bounded http(s) image URLs from every signal we
 * already trust on the page: og:image*, JSON-LD image/thumbnailUrl/ImageObject,
 * and `<img>`/`<source>` markup. These are surfaced for the agent to optionally
 * vision-fetch — they are NEVER fetched by this service, so there is no SSRF
 * egress, but private-IP / localhost hosts are still stripped (string check,
 * no DNS) so internal targets are not advertised to an external model.
 *
 * Returns `undefined` when no usable image is found so the field stays absent
 * (keeps the contract fixtures, which carry no images, byte-identical).
 */
export function extractImages(
  html: string,
  baseUrl: string,
  og: Record<string, string> | undefined,
  jsonLd: unknown,
): string[] | undefined {
  const candidates: string[] = [];
  pushOgImages(candidates, og);
  pushJsonLdImages(candidates, jsonLd);
  pushMarkupImages(candidates, html);

  const seen = new Set<string>();
  const images: string[] = [];
  for (const raw of candidates) {
    const resolved = resolveImage(raw, baseUrl);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    images.push(resolved);
    if (images.length >= MAX_IMAGES) break;
  }
  return images.length > 0 ? images : undefined;
}

function pushOgImages(out: string[], og: Record<string, string> | undefined): void {
  if (!og) return;
  for (const key of OG_IMAGE_KEYS) {
    const value = og[key];
    if (value) out.push(value);
  }
}

function pushJsonLdImages(out: string[], jsonLd: unknown): void {
  for (const node of asArray(jsonLd)) {
    if (!isRecord(node)) continue;
    if (isImageObject(node)) {
      // The node itself is an image — its url/contentUrl are the image (not a canonical URL).
      pushImageValue(out, node.url);
      pushImageValue(out, node.contentUrl);
      continue;
    }
    pushImageValue(out, node.image);
    pushImageValue(out, node.thumbnailUrl);
    descendGraph(out, node["@graph"]);
  }
}

function descendGraph(out: string[], graph: unknown): void {
  for (const node of asArray(graph)) {
    if (!isRecord(node)) continue;
    if (isImageObject(node)) {
      pushImageValue(out, node.url);
      pushImageValue(out, node.contentUrl);
      continue;
    }
    pushImageValue(out, node.image);
    pushImageValue(out, node.thumbnailUrl);
  }
}

/** A node typed schema.org/ImageObject — only these carry image url/contentUrl directly. */
function isImageObject(node: Record<string, unknown>): boolean {
  const type = node["@type"];
  const types = Array.isArray(type) ? type.map(String) : type === undefined ? [] : [String(type)];
  return types.some((t) => shortSchemaType(t) === "imageobject");
}

/** Normalize a schema.org @type to its short lowercase form (e.g. "imageobject"). */
function shortSchemaType(value: string): string {
  const lower = value.toLowerCase().replace(/^https?:\/\/schema\.org\//, "");
  return lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
}

/** Accept a bare URL string, an ImageObject `{url|contentUrl}`, or a list of either. */
function pushImageValue(out: string[], value: unknown): void {
  for (const item of asArray(value)) {
    if (typeof item === "string") {
      out.push(item);
    } else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const url = record.url ?? record.contentUrl;
      if (typeof url === "string") out.push(url);
    }
  }
}

function pushMarkupImages(out: string[], html: string): void {
  for (const tag of findStartTags(html, "img", MAX_MARKUP_SCAN)) {
    const src = tag.attrs.src ?? tag.attrs["data-src"] ?? tag.attrs["data-lazy-src"];
    if (src) out.push(src);
  }
  for (const tag of findStartTags(html, "source", MAX_MARKUP_SCAN)) {
    const srcset = tag.attrs.srcset ?? tag.attrs["data-srcset"];
    if (srcset) out.push(firstSrcsetUrl(srcset));
  }
}

/** srcset is `url descriptor, url descriptor, …` — take the first URL only. */
function firstSrcsetUrl(srcset: string): string {
  const first = srcset.split(",")[0] ?? "";
  return first.trim().split(/\s+/)[0] ?? "";
}

function resolveImage(raw: string, baseUrl: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (isInternalHost(url.hostname)) return undefined;
  if (url.href.length > MAX_URL_LENGTH) return undefined;
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.href;
}

/**
 * Reject loopback/private/internal hosts WITHOUT DNS (string check only). This
 * is STRICTER than the egress guard's hostname check (dns.ts) on purpose: images
 * bypass DNS entirely (never fetched), so hostnames the DNS path would resolve
 * to a private IP must be matched by name here. WHATWG URLs preserve a trailing
 * dot ("localhost."), so that is stripped first. This is hygiene to avoid
 * advertising internal targets to an external model — NOT an egress boundary.
 */
function isInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (METADATA_HOSTS.has(host)) return true;
  if (ipVersion(host) !== 0 && isPrivate(host)) return true;
  return false;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Stateless policy for forwarding a Tier-3 in-browser POST through FetcherPort (#111).
//
// The browser never makes its own egress: every request is intercepted by `page.route`.
// GETs are fulfilled directly; non-GETs used to be aborted outright (`unsupported_browser_method`).
// This module decides whether a non-GET is an authorized FIRST-PARTY POST worth forwarding
// (Notion/Jira hydrate via POST to a same-registrable-domain API), and materializes its body
// + allowlisted Content-Type into a `PostInit`. It owns NO pool/semaphore state —
// `RenderRouteState.handle()` performs the byte accounting + concurrency (so the body is
// counted against the ESSENTIAL pool at dispatch and released on reject — see route-state.ts).
//
// Security order is load-bearing: the GATE runs before any body is considered, so a
// third-party / non-POST / document POST is aborted before its bytes count against the pool.
// The body is NEVER truncated (a truncated JSON body elicits a corrupt 400) — it is forwarded
// whole under the cap or aborted. Content-Type is the ONLY forwarded header; Cookie/Auth/
// Origin/Referer/Content-Length are stripped upstream (the fetcher derives Content-Length).
import { isSameRegistrableDomain } from "../../domain/registrable-domain.ts";
import type { PostInit } from "../../application/ports/fetcher.ts";

/** Resource types whose POSTs may carry page data the client app needs to hydrate. A POST
 *  to a document/subframe/stylesheet/etc. is not a data fetch — abort it. */
const DATA_FETCH_TYPES = new Set(["fetch", "xhr"]);

export interface PostForwardInput {
  method: string;
  resourceType: string;
  url: string;
  /** The request body (request.postDataBuffer()); null when the request has no body. */
  body: Uint8Array | null;
  /** The request's `content-type` header (validated; forwarded only when a body is present). */
  contentType?: string;
  /** The request's `content-length` header (advisory pre-check before materializing). */
  contentLength?: string;
  /** The page's registrable domain (computed once in RenderRouteState); null on IP/localhost. */
  mainRegistrableDomain: string | null;
  /** Per-render POST body cap (CAPTATUM_RENDER_POST_MAX_BYTES). */
  maxBytes: number;
}

export type PostForwardPlan =
  | { kind: "forward"; body: Uint8Array; postInit: PostInit }
  | { kind: "abort"; reason: string };

/** Decide whether a non-GET Tier-3 request forwards as a first-party POST, or aborts. The
 *  `unsupported_browser_method` reason covers every gate failure (non-POST, non-fetch/xhr,
 *  document, third-party) — one code, clean provenance, no fragmenting. */
export function planPostForward(input: PostForwardInput): PostForwardPlan {
  const host = hostnameOf(input.url);
  // Gate FIRST. mainRegistrableDomain null (IP/localhost) -> isSameRegistrableDomain is false
  // (null !== null is fail-closed), so the POST aborts rather than forwarding on an ambiguous host.
  if (
    input.method !== "POST"
    || !DATA_FETCH_TYPES.has(input.resourceType)
    || !isSameRegistrableDomain(host, input.mainRegistrableDomain ?? "")
  ) {
    return { kind: "abort", reason: "unsupported_browser_method" };
  }
  if (input.body === null) return { kind: "abort", reason: "unreadable_post_body" };

  // Advisory Content-Length pre-check: reject a page that declares an oversized body before we
  // would count its bytes against the pool. The hard cap below is authoritative either way.
  const declared = parseContentLength(input.contentLength);
  if (declared !== null && declared > input.maxBytes) {
    return { kind: "abort", reason: "request_body_too_large" };
  }
  // Hard cap (NEVER truncate — a half JSON body 400s; a clean abort lets the page degrade).
  if (input.body.byteLength > input.maxBytes) {
    return { kind: "abort", reason: "request_body_too_large" };
  }
  // Content-Type allowlist validation: length cap (defense-in-depth) + no CRLF/NUL (header
  // injection). Node's validateHeaderValue already rejects control bytes on the wire; this
  // guards the value before it reaches the fetcher. Absent Content-Type is forwarded as-such.
  if (input.contentType !== undefined) {
    if (input.contentType.length > 256 || /[\r\n\0]/.test(input.contentType)) {
      return { kind: "abort", reason: "invalid_post_header" };
    }
  }

  return {
    kind: "forward",
    body: input.body,
    postInit: {
      method: "POST",
      body: input.body,
      ...(input.contentType !== undefined ? { requestContentType: input.contentType } : {}),
    },
  };
}

function parseContentLength(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

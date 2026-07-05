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

/** Phase 1 (NO body read): the gate + the advisory Content-Length pre-check. Run BEFORE
 *  `request.postDataBuffer()` so a page that DECLARES an oversized body is rejected without
 *  materializing it into the Node process (memory-DoS guard — #111 codex P1). The gate also
 *  runs first so a third-party POST is rejected before any cap signal. */
export function authorizePostForward(input: {
  method: string; resourceType: string; url: string;
  contentLength?: string; mainRegistrableDomain: string | null; maxBytes: number;
}): { kind: "proceed" } | { kind: "abort"; reason: string } {
  const host = hostnameOf(input.url);
  // Gate: mainRegistrableDomain null (IP/localhost) -> isSameRegistrableDomain false (fail-closed).
  if (
    input.method !== "POST"
    || !DATA_FETCH_TYPES.has(input.resourceType)
    || !isSameRegistrableDomain(host, input.mainRegistrableDomain ?? "")
  ) {
    return { kind: "abort", reason: "unsupported_browser_method" };
  }
  const declared = parseContentLength(input.contentLength);
  if (declared !== null && declared > input.maxBytes) {
    return { kind: "abort", reason: "request_body_too_large" };
  }
  return { kind: "proceed" };
}

/** Phase 2 (body read): null check + hard cap (NEVER truncate) + Content-Type validation. */
export function materializePostForward(input: {
  body: Uint8Array | null; contentType?: string; maxBytes: number;
}): PostForwardPlan {
  if (input.body === null) return { kind: "abort", reason: "unreadable_post_body" };
  if (input.body.byteLength > input.maxBytes) return { kind: "abort", reason: "request_body_too_large" };
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

/** Convenience wrapper: authorize then materialize (for tests + callers that already hold the body).
 *  The production path (RenderRouteState) calls the two phases separately so the body is NOT read
 *  until `authorizePostForward` passes. */
export function planPostForward(input: PostForwardInput): PostForwardPlan {
  const auth = authorizePostForward(input);
  if (auth.kind === "abort") return auth;
  return materializePostForward(input);
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

/** Headers added to a forwarded POST response so the in-render browser's CORS check admits the
 *  cross-origin response (e.g. developer.atlassian.com reading api.atlassian.com's response). The
 *  POST is already first-party-gated; this only tells captatum's OWN controlled browser the
 *  response is cross-origin-readable. `*` is valid because the POST carries no credentials
 *  (Cookie/Auth are never forwarded — D5). */
export const CORS_ALLOW_ORIGIN: Record<string, string> = { "access-control-allow-origin": "*" };

/** A first-party CORS preflight (OPTIONS) for a cross-origin POST gets a SYNTHESIZED permissive
 *  response so the browser proceeds to the POST. Not forwarded: captatum is the fetcher in its
 *  own controlled render, not a real cross-origin client the upstream must authorize, and the POST
 *  itself is already first-party-gated. (Forwarding the preflight would also drop Origin — D5 — so
 *  the upstream could not return a matching ACAO.) */
const CORS_PREFLIGHT_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  // `*` covers any Access-Control-Request-Headers (x-requested-with, tracing headers, …) without
  // echoing attacker-controlled names. Valid: the POST carries no credentials (#111 codex P2).
  "access-control-allow-headers": "*",
  "access-control-max-age": "600",
};

/** Decide whether a Tier-3 OPTIONS request is an authorized first-party CORS preflight to respond
 *  to (permissively) or to abort. Same first-party gate as the POST: only same-registrable-domain
 *  fetch/xhr preflights are honored. (#111 codex P1.) */
export function planOptionsPreflight(input: { resourceType: string; url: string; mainRegistrableDomain: string | null }):
  | { kind: "respond"; headers: Record<string, string> }
  | { kind: "abort"; reason: string } {
  if (input.resourceType !== "fetch" && input.resourceType !== "xhr") {
    return { kind: "abort", reason: "unsupported_browser_method" };
  }
  if (!isSameRegistrableDomain(hostnameOf(input.url), input.mainRegistrableDomain ?? "")) {
    return { kind: "abort", reason: "unsupported_browser_method" };
  }
  return { kind: "respond", headers: CORS_PREFLIGHT_HEADERS };
}

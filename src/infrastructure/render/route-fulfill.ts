import type {
  FetcherOptions,
  FetcherPort,
  FetcherResult,
  PostInit,
  Redirect,
  RejectResult,
} from "../../application/ports/fetcher.ts";

/** A Tier-3 browser request resolved into either a fulfill payload or an SSRF reject. */
export type FulfillOutcome =
  | {
      kind: "fulfill";
      status: number;
      contentType: string;
      body: Uint8Array;
      finalUrl: string;
      redirects: Redirect[];
    }
  | {
      kind: "reject";
      reject: RejectResult;
      /** Bytes already downloaded before the reject (a mid-read-truncated subresource body that is
       *  aborted rather than fulfilled) — counted against the render byte pool + egress hosts so the
       *  budget stays honest even when the partial bytes never reach the browser (#149 codex P2).
       *  Absent when no bytes were downloaded (a pre-egress block / zero-byte reject). */
      countedBytes?: number;
      countedFinalUrl?: string;
      countedRedirects?: Redirect[];
    };

/**
 * MIME to assume when the response carries no Content-Type, keyed by the
 * Playwright request `resourceType`. A header-less NAVIGATION must be text/html
 * or Chromium downloads it (page.goto throws); a header-less script/stylesheet
 * needs a real JS/CSS MIME because Chromium will NOT sniff-and-execute text/html
 * as script. Other types (xhr/fetch) leave it empty so the page interprets bytes.
 */
const DEFAULT_MIME: Record<string, string> = {
  document: "text/html; charset=utf-8",
  script: "text/javascript",
  stylesheet: "text/css",
};

/**
 * Resolves a Tier-3 browser request through the hardened FetcherPort so the
 * browser never resolves or connects on its own. `fetchGuarded` pins the
 * connection to the guard-resolved IP and re-validates every redirect hop
 * against the SSRF guards (`maxHops` enforced) — exactly the property
 * `route.continue()` dropped, closing the DNS-rebinding + redirect TOCTOU
 * (TIER3-SSRF-1/2/NAV-1). `readCappedBody` already decompresses the body, so the
 * payload is served identity-encoded with at most a content-type (no
 * content-encoding echo, which would make the browser double-decompress).
 */
export interface RouteFulfiller {
  resolve(url: string, resourceType: string, postInit?: PostInit): Promise<FulfillOutcome>;
}

export class FetcherRouteFulfiller implements RouteFulfiller {
  private readonly fetcher: FetcherPort;
  private readonly opts: FetcherOptions;

  constructor(fetcher: FetcherPort, opts: FetcherOptions) {
    this.fetcher = fetcher;
    this.opts = opts;
  }

  async resolve(url: string, resourceType: string, postInit?: PostInit): Promise<FulfillOutcome> {
    // `this.opts` stays immutable GET-shaped; `postInit` is a per-call descriptor so a
    // POST-then-GET sequence can never leak method/body into the next GET subresource (#111 D1).
    const result = await this.fetcher.fetchGuarded(url, this.opts, postInit);
    if ("rejected" in result) return { kind: "reject", reject: result };
    // A mid-read-truncated subresource body (transport `body_read_error`) is unreliable — a
    // half-loaded JS/CSS bundle can corrupt the render worse than an aborted request — so abort
    // the route rather than fulfilling partial bytes (#149). The main-page captatum path keeps
    // the partial as degraded content; this is subresource-specific.
    if (result.truncatedReason === "body_read_error") {
      // The partial bytes were already downloaded by readCappedBody — carry them on the reject so
      // RenderRouteState counts them against the render byte pool + egress hosts (the budget must
      // stay honest even when the partial body is aborted rather than fulfilled, #149 codex P2).
      return {
        kind: "reject",
        reject: { rejected: true, code: "body_read_error", message: "Tier-3 subresource body truncated mid-read" },
        countedBytes: result.bytes,
        countedFinalUrl: result.finalUrl,
        countedRedirects: result.redirects,
      };
    }
    let body: Uint8Array;
    try {
      // Each subresource body is buffered in the gateway up to opts.maxBytes
      // (readCappedBody already capped it per request). A cross-subresource
      // cumulative cap is the TIER3-DOS-1 control (separate PR); the render
      // timeout bounds the worst case here.
      body = Buffer.from(await new Response(result.bodyStream).arrayBuffer());
    } catch {
      // The fetch already reached a guard-validated public IP, so a failure here
      // is only a byte-transfer problem — reject so the route is always aborted
      // rather than left unresolved (which would hang the request until timeout).
      return {
        kind: "reject",
        reject: { rejected: true, code: "body_read_error", message: "Tier-3 fulfill body could not be read" },
      };
    }
    return {
      kind: "fulfill",
      status: result.status,
      contentType: result.contentType || DEFAULT_MIME[resourceType] || "",
      body,
      finalUrl: result.finalUrl,
      redirects: result.redirects,
    };
  }
}

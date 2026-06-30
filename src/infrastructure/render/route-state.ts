import type { FetcherResult, RejectResult } from "../../application/ports/fetcher.ts";
import type { RenderAction, RenderInput } from "../../application/ports/renderer.ts";
import { isAdTrackerHost, isFirstPartyHost } from "../../domain/adblock.ts";
import type { PlaywrightFrame, PlaywrightRequest, PlaywrightRoute } from "./playwright-types.ts";
import { safeRenderUrl, type BrowserUrlGuard } from "./browser-url-guard.ts";
import { FetcherRouteFulfiller, type RouteFulfiller } from "./route-fulfill.ts";

const BLOCKED_TYPES = new Set(["image", "font", "media"]);

/**
 * Per-request route state for the Tier-3 render. The browser NEVER makes its own
 * egress: every non-aborted GET is resolved through the guarded FetcherPort and
 * fulfilled with the fetched bytes (`route.fulfill`), so the connection is pinned
 * to the guard-resolved IP and every redirect hop is re-validated against the
 * SSRF guards with `maxHops` enforced. Ad/tracker + blocked body types and non-GET
 * requests are aborted before any network; aborted body types are still P1/DNS
 * private-IP-checked so the action log records a private target. This closes the
 * DNS-rebinding + redirect TOCTOU that `route.continue()` left open
 * (TIER3-SSRF-1/2/NAV-1) — Chromium no longer resolves or connects by name.
 */
export class RenderRouteState {
  readonly input: RenderInput;
  readonly actions: RenderAction[];
  readonly guard: BrowserUrlGuard;
  private readonly fulfiller: RouteFulfiller;
  private readonly mainHost: string;
  status = 200;
  finalUrl = "";
  redirects: FetcherResult["redirects"] = [];
  fatal?: RejectResult;
  private mainFrame?: PlaywrightFrame;
  private bytesFulfilled = 0;
  private budgetExceeded = false;

  constructor(input: RenderInput, actions: RenderAction[], guard: BrowserUrlGuard) {
    this.input = input;
    this.actions = actions;
    this.guard = guard;
    this.mainHost = hostnameOf(input.url);
    this.fulfiller = new FetcherRouteFulfiller(input.fetcher, {
      maxBytes: input.maxBytes,
      timeoutMs: input.timeoutMs,
      maxHops: input.maxHops,
    });
  }

  /** Set after the page exists; main-frame requests are told apart from iframe
    * documents by frame === page.mainFrame(). */
  setMainFrame(frame: PlaywrightFrame): void {
    this.mainFrame = frame;
  }

  /**
   * request.frame() throws for a navigation request Playwright hasn't created the
   * frame for yet (see Playwright's Request.frame docs). Treat that — and a
   * missing frame() — as "not main-frame" so the route still resolves (a guarded
   * reject is still aborted) rather than erroring or masking the reject.
   */
  private isMainFrame(request: PlaywrightRequest): boolean {
    try {
      return this.mainFrame !== undefined && request.frame?.() === this.mainFrame;
    } catch {
      return false;
    }
  }

  async handle(route: PlaywrightRoute): Promise<void> {
    const request = route.request();
    const url = request.url();
    const resourceType = request.resourceType();
    // The main-frame document navigation is the page the user asked to fetch — it is
    // never an ad/tracker (even when its host is a blocklisted vendor apex like
    // amplitude.com), and it owns provenance below. Computed once and reused.
    const mainFrameNav = isNavigation(request) && this.isMainFrame(request);
    if (!mainFrameNav && shouldAbortWithoutBody(url, resourceType, this.mainHost)) {
      return this.abortBlockedType(route, url, resourceType);
    }
    if (!mainFrameNav && request.method() !== "GET") {
      return this.abort(route, url, resourceType, "unsupported_browser_method");
    }
    if (this.budgetExceeded) {
      return this.abort(route, url, resourceType, "render_byte_budget", "resource-aborted");
    }
    const outcome = await this.fulfiller.resolve(url, resourceType);
    if (outcome.kind === "reject") {
      if (mainFrameNav) this.fatal = outcome.reject;
      return this.abort(route, url, resourceType, outcome.reject.code, "request-blocked");
    }
    if (mainFrameNav) {
      // The main-frame document navigation owns provenance, updated on EVERY such
      // navigation — including a client-side same-tab navigation after the first
      // load (e.g. location.href = '/canonical'). Subframe documents also satisfy
      // isNavigationRequest(); we tell them apart by frame === page.mainFrame() so
      // an iframe never clobbers finalUrl/redirects, and a subframe reject is not
      // fatal (only the main frame's failure fails the render).
      this.status = outcome.status;
      this.finalUrl = outcome.finalUrl;
      this.redirects = outcome.redirects;
      // Fidelity note: the navigation body is served against the ORIGINAL request
      // URL, so for a cross-origin redirect the browser's base URL stays the
      // original origin (relative subresources resolve there and may miss) and
      // Set-Cookie from intermediate hops is not carried. Replaying a 302 to
      // finalUrl would fix the base URL, but Playwright does not follow a
      // fulfilled redirect for a navigation. Render-fidelity limit for
      // cross-origin redirects only — every hop was guard-validated, not an SSRF gap.
    }
    // TIER3-DOS-1: abort this response if it would push cumulative bytes over the
    // render budget. The response that crosses the cap is NOT fulfilled.
    if (this.bytesFulfilled + outcome.body.byteLength > this.input.maxBytes) {
      this.budgetExceeded = true;
      return this.abort(route, url, resourceType, "render_byte_budget", "resource-aborted");
    }
    this.bytesFulfilled += outcome.body.byteLength;
    await route.fulfill({
      status: outcome.status,
      body: outcome.body,
      ...(outcome.contentType ? { contentType: outcome.contentType } : {}),
    });
  }

  private async abortBlockedType(
    route: PlaywrightRoute,
    url: string,
    resourceType: string,
  ): Promise<void> {
    const blocked = await this.guard.check(url, AbortSignal.timeout(this.input.timeoutMs));
    const reason = blocked?.code ?? `blocked_${resourceType}`;
    await this.abort(route, url, resourceType, reason, "resource-aborted");
  }

  private async abort(
    route: PlaywrightRoute,
    url: string,
    resourceType: string,
    reason: string,
    type: RenderAction["type"] = "request-blocked",
  ): Promise<void> {
    this.actions.push({ type, reason, url: safeRenderUrl(url), resourceType });
    await route.abort("blockedbyclient");
  }
}

/** Body types we never fetch, and ad/tracker subresources, are aborted before any
 *  network. Adblock is THIRD-PARTY only: the fetched page's own (first-party) host
 *  is exempt so a blocklisted vendor apex that IS the requested page (amplitude.com,
 *  hotjar.com, …) still loads. The main-frame navigation is exempted by the caller.
 *  Like blocked body types, an aborted ad/tracker URL is still P1/DNS private-IP-
 *  checked (abortBlockedType) so the action log records a private target. */
function shouldAbortWithoutBody(url: string, resourceType: string, mainHost: string): boolean {
  if (BLOCKED_TYPES.has(resourceType)) return true;
  if (isFirstPartyHost(hostnameOf(url), mainHost)) return false; // first-party subresource
  return isAdTracker(url);
}

function isAdTracker(input: string): boolean {
  try {
    return isAdTrackerHost(new URL(input).hostname);
  } catch {
    return true;
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isNavigation(request: { isNavigationRequest?: () => boolean; resourceType(): string }): boolean {
  return request.isNavigationRequest?.() ?? request.resourceType() === "document";
}

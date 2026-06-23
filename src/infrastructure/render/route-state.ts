import type { FetcherResult, RejectResult } from "../../application/ports/fetcher.ts";
import type { RenderAction, RenderInput } from "../../application/ports/renderer.ts";
import type { PlaywrightFrame, PlaywrightRequest, PlaywrightRoute } from "./playwright-types.ts";
import { safeRenderUrl, type BrowserUrlGuard } from "./browser-url-guard.ts";
import { FetcherRouteFulfiller, type RouteFulfiller } from "./route-fulfill.ts";

const BLOCKED_TYPES = new Set(["image", "font", "media"]);
const ANALYTICS_HOSTS = [
  "doubleclick.net",
  "google-analytics.com",
  "googletagmanager.com",
  "mixpanel.com",
  "segment.io",
];

/**
 * Per-request route state for the Tier-3 render. The browser NEVER makes its own
 * egress: every non-aborted GET is resolved through the guarded FetcherPort and
 * fulfilled with the fetched bytes (`route.fulfill`), so the connection is pinned
 * to the guard-resolved IP and every redirect hop is re-validated against the
 * SSRF guards with `maxHops` enforced. Analytics/blocked body types and non-GET
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
  status = 200;
  finalUrl = "";
  redirects: FetcherResult["redirects"] = [];
  fatal?: RejectResult;
  private mainFrame?: PlaywrightFrame;

  constructor(input: RenderInput, actions: RenderAction[], guard: BrowserUrlGuard) {
    this.input = input;
    this.actions = actions;
    this.guard = guard;
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
    if (shouldAbortWithoutBody(url, resourceType)) {
      return this.abortBlockedType(route, url, resourceType);
    }
    if (request.method() !== "GET") {
      return this.abort(route, url, resourceType, "unsupported_browser_method");
    }
    const outcome = await this.fulfiller.resolve(url, resourceType);
    const mainFrameNav = isNavigation(request) && this.isMainFrame(request);
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

function shouldAbortWithoutBody(url: string, resourceType: string): boolean {
  return BLOCKED_TYPES.has(resourceType) || isAnalytics(url);
}

function isAnalytics(input: string): boolean {
  try {
    const host = new URL(input).hostname.toLowerCase();
    return ANALYTICS_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
  } catch {
    return true;
  }
}

function isNavigation(request: { isNavigationRequest?: () => boolean; resourceType(): string }): boolean {
  return request.isNavigationRequest?.() ?? request.resourceType() === "document";
}

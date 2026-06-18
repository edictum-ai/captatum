import type { FetcherResult, RejectResult } from "../../application/ports/fetcher.ts";
import type { RenderAction, RenderInput } from "../../application/ports/renderer.ts";
import type { PlaywrightRoute } from "./playwright-types.ts";
import { safeRenderUrl, type BrowserUrlGuard } from "./browser-url-guard.ts";

const BLOCKED_TYPES = new Set(["image", "font", "media"]);
const ANALYTICS_HOSTS = [
  "doubleclick.net",
  "google-analytics.com",
  "googletagmanager.com",
  "mixpanel.com",
  "segment.io",
];

/**
 * Per-request route state for the Tier-3 render. The browser fetches resources
 * natively; this handler only enforces egress policy: abort analytics/blocked
 * body types, abort non-GET, and abort any request whose host resolves to a
 * private/reserved address (SSRF). Everything else continues. Re-fetching and
 * re-fulfilling every subresource through the guarded fetcher was the earlier
 * design — it gave no extra SSRF value over this IP check and hung page.goto.
 */
export class RenderRouteState {
  readonly input: RenderInput;
  readonly actions: RenderAction[];
  readonly guard: BrowserUrlGuard;
  status = 200;
  finalUrl = "";
  redirects: FetcherResult["redirects"] = [];
  fatal?: RejectResult;

  constructor(input: RenderInput, actions: RenderAction[], guard: BrowserUrlGuard) {
    this.input = input;
    this.actions = actions;
    this.guard = guard;
  }

  async handle(route: PlaywrightRoute): Promise<void> {
    const request = route.request();
    const url = request.url();
    const resourceType = request.resourceType();
    if (shouldAbortWithoutBody(url, resourceType)) {
      await this.abortAfterGuard(route, url, resourceType);
      return;
    }
    if (request.method() !== "GET") {
      await this.abort(route, url, resourceType, "unsupported_browser_method");
      return;
    }
    const blocked = await this.guard.check(url, AbortSignal.timeout(this.input.timeoutMs));
    if (blocked) {
      if (isNavigation(request)) this.fatal = blocked;
      await this.abort(route, url, resourceType, blocked.code, "request-blocked");
      return;
    }
    await route.continue();
  }

  private async abortAfterGuard(
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

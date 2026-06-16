import type {
  FetcherOptions,
  FetcherResult,
  RejectResult,
} from "../../application/ports/fetcher.ts";
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

export class RenderRouteState {
  readonly input: RenderInput;
  readonly actions: RenderAction[];
  readonly guard: BrowserUrlGuard;
  status = 200;
  finalUrl = "";
  redirects: FetcherResult["redirects"] = [];
  fetchedBytes = 0;
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
    const fetched = await this.fetch(url);
    if ("rejected" in fetched) {
      if (isNavigation(request)) this.fatal = fetched;
      await this.abort(route, url, resourceType, fetched.code);
      return;
    }
    await this.fulfill(route, fetched, isNavigation(request));
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

  private async fetch(url: string): Promise<FetcherResult | RejectResult> {
    const remaining = this.input.maxBytes - this.fetchedBytes;
    if (remaining <= 0) return maxBytesReject();
    return await this.input.fetcher.fetchGuarded(url, {
      maxBytes: remaining,
      timeoutMs: this.input.timeoutMs,
      maxHops: this.input.maxHops,
    } satisfies FetcherOptions);
  }

  private async fulfill(
    route: PlaywrightRoute,
    fetched: FetcherResult,
    mainNavigation: boolean,
  ): Promise<void> {
    this.fetchedBytes += fetched.bytes;
    if (this.fetchedBytes > this.input.maxBytes) {
      this.fatal = maxBytesReject();
      await route.abort("blockedbyclient");
      return;
    }
    if (mainNavigation) {
      this.status = fetched.status;
      this.finalUrl = fetched.finalUrl;
      this.redirects = fetched.redirects;
    }
    const body = new Uint8Array(await new Response(fetched.bodyStream).arrayBuffer());
    await route.fulfill({
      status: fetched.status,
      body,
      contentType: fetched.contentType || undefined,
      headers: fetched.contentType ? { "content-type": fetched.contentType } : undefined,
    });
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

export function maxBytesReject(): RejectResult {
  return { rejected: true, code: "max_bytes", message: "Rendered page exceeds the byte cap" };
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

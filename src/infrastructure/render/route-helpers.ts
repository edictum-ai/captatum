// Stateless route helpers shared by RenderRouteState — kept here so route-state.ts stays
// under the 250-line limit. Pure functions; no per-render state.
import { isAdTrackerHost, isFirstPartyHost } from "../../domain/adblock.ts";

/** Body types we never fetch, and ad/tracker subresources, are aborted before any network.
 *  Adblock is THIRD-PARTY only: the fetched page's own (first-party) host is exempt so a
 *  blocklisted vendor apex that IS the requested page (amplitude.com, hotjar.com, …) still
 *  loads. The main-frame navigation is exempted by the caller. */
export function shouldAbortWithoutBody(url: string, resourceType: string, mainHost: string): boolean {
  if (BLOCKED_TYPES.has(resourceType)) return true;
  if (isFirstPartyHost(hostnameOf(url), mainHost)) return false; // first-party subresource
  return isAdTracker(url);
}

export function isAdTracker(input: string): boolean {
  try {
    return isAdTrackerHost(new URL(input).hostname);
  } catch {
    return true;
  }
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isNavigation(request: { isNavigationRequest?: () => boolean; resourceType(): string }): boolean {
  return request.isNavigationRequest?.() ?? request.resourceType() === "document";
}

const BLOCKED_TYPES = new Set(["image", "font", "media"]);

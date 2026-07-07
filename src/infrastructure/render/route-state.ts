import type { FetcherResult, RejectResult } from "../../application/ports/fetcher.ts";
import type { RenderAction, RenderInput } from "../../application/ports/renderer.ts";
import { registrableDomain } from "../../domain/registrable-domain.ts";
import { config } from "../../config.ts";
import type { PlaywrightFrame, PlaywrightRequest, PlaywrightRoute } from "./playwright-types.ts";
import { safeRenderUrl, type BrowserUrlGuard } from "./browser-url-guard.ts";
import { FetcherRouteFulfiller, type RouteFulfiller } from "./route-fulfill.ts";
import { authorizePostForward, CORS_ALLOW_ORIGIN, materializePostForward, planOptionsPreflight } from "./post-forward.ts";
import { RenderEgressHosts } from "./render-egress.ts";
import { Semaphore } from "./semaphore.ts";
import { hostnameOf, isNavigation, shouldAbortWithoutBody } from "./route-helpers.ts";

/** Render resource types the page's CLIENT APP needs to load, or it throws a
 *  client-side exception (Next.js "Application error: a client-side exception has
 *  occurred"): scripts, data fetches/XHR, and documents. These are EXEMPT from the
 *  cumulative render byte budget — aborting one mid-load (e.g. an auth script like
 *  Clerk, or a /api/flags fetch the app awaits) crashes the app and yields an
 *  error-boundary page instead of content. They remain per-response `maxBytes`-capped
 *  by the fetcher; image/font/media stay always-blocked; the render is `timeoutMs`-
 *  bounded — so the realistic DoS vectors (huge media, huge single responses, run
 *  time) stay bounded. (cerebralvalley.ai event pages: clerk.browser.js.) */
const ESSENTIAL_RENDER_TYPES = new Set(["script", "fetch", "xhr", "document"]);

/** The essential pool (script/fetch/xhr/document) gets this many× the non-essential cap.
 *  Heavy modern docs/apps (Cursor, Jira) ship >5MB of JS/data; at a 1× cap those scripts are
 *  aborted mid-load and the client app crashes into an error boundary ("Something went wrong")
 *  instead of rendering content. 3× keeps total per-render egress bounded at ~4×maxBytes
 *  (~20MB at the 5MB default) while letting the client app actually load. Image/font/media stay
 *  always-blocked and the render stays timeoutMs-bounded, so the realistic DoS vectors remain
 *  capped. (#110) */
export const ESSENTIAL_BUDGET_MULTIPLIER = 3;

function isEssentialRenderType(resourceType: string): boolean {
  return ESSENTIAL_RENDER_TYPES.has(resourceType);
}

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
  private readonly mainRegistrableDomain: string | null;
  private readonly postMaxBytes: number;
  private readonly postSemaphore: Semaphore;
  status = 200;
  finalUrl = "";
  redirects: FetcherResult["redirects"] = [];
  fatal?: RejectResult;
  private mainFrame?: PlaywrightFrame;
  // Two cumulative byte pools, each capped at maxBytes: non-essential (stylesheets,
  // etc.) and essential (script/fetch/xhr/document). Splitting them means a page
  // whose non-essential budget is blown still gets its essential scripts/data (so the
  // client app doesn't crash), while total egress stays bounded at ~2×maxBytes.
  private bytesFulfilled = 0;
  private essentialBytes = 0;
  private budgetExceeded = false;
  private essentialBudgetExceeded = false;
  // Registrable domains of fulfilled subresources → Result.renderEgressHosts (BULK-3).
  private readonly egressHostsList = new RenderEgressHosts();

  constructor(input: RenderInput, actions: RenderAction[], guard: BrowserUrlGuard) {
    this.input = input;
    this.actions = actions;
    this.guard = guard;
    this.mainHost = hostnameOf(input.url);
    // Computed ONCE from the page URL; NEVER recomputed on a same-tab navigation — the
    // POST first-party scope never expands mid-render (a security property, not accident).
    this.mainRegistrableDomain = registrableDomain(this.mainHost);
    this.postMaxBytes = config.render.postMaxBytes();
    this.postSemaphore = new Semaphore(config.render.postConcurrency());
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

  /** Total network egress for the render (every fulfilled subresource's bytes) →
   *  `Result.egressBytes` (BULK-5). Distinct from `fetchResult.bytes` (rendered DOM). */
  egressBytes(): number { return this.bytesFulfilled + this.essentialBytes; }

  /** Registrable domains the render loaded subresources from → bulk per-host union (BULK-3). */
  egressHosts(): string[] { return this.egressHostsList.get(); }

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
    // The main-frame document navigation is the page the user asked to fetch — never an ad/tracker
    // (even when its host is a blocklisted vendor apex like amplitude.com); owns provenance below.
    const mainFrameNav = isNavigation(request) && this.isMainFrame(request);
    if (!mainFrameNav && shouldAbortWithoutBody(url, resourceType, this.mainHost)) {
      return this.abortBlockedType(route, url, resourceType);
    }
    if (!mainFrameNav && request.method() !== "GET") {
      return this.handleNonGet(route, request, url, resourceType);
    }
    // Once a pool is blown, subsequent resources in THAT pool abort before network. Essentials
    // and non-essentials have separate pools, so a blown non-essential budget still lets essentials through.
    if (isEssentialRenderType(resourceType) ? this.essentialBudgetExceeded : this.budgetExceeded) {
      return this.abort(route, url, resourceType, "render_byte_budget", "resource-aborted");
    }
    const outcome = await this.fulfiller.resolve(url, resourceType);
    if (outcome.kind === "reject") {
      if (mainFrameNav) this.fatal = outcome.reject;
      return this.abort(route, url, resourceType, outcome.reject.code, "request-blocked");
    }
    if (mainFrameNav) {
      // The main-frame document navigation owns provenance (updated on EVERY main-frame nav,
      // incl. a client-side same-tab nav). Subframe documents also satisfy isNavigationRequest();
      // frame === page.mainFrame() tells them apart so an iframe never clobbers finalUrl/redirects
      // and a subframe reject is not fatal.
      this.status = outcome.status;
      this.finalUrl = outcome.finalUrl;
      this.redirects = outcome.redirects;
      // Fidelity limit: the nav body is served against the ORIGINAL request URL (a cross-origin
      // redirect's base stays the original origin; relative subresources may miss; intermediate
      // Set-Cookie isn't carried — Playwright can't follow a fulfilled redirect for a nav). Every
      // hop was guard-validated, not an SSRF gap.
    }
    const essential = isEssentialRenderType(resourceType);
    // Count EVERY resolved body + its redirect/final hosts — including ones then aborted by the byte
    // cap — because the egress already happened (codex R2 P2). Essential cap is ESSENTIAL_BUDGET_MULTIPLIER×
    // non-essential; NON-essential crossing → abort, ESSENTIAL → fulfill.
    const countFetched = (): void => {
      if (essential) this.essentialBytes += outcome.body.byteLength;
      else this.bytesFulfilled += outcome.body.byteLength;
      this.egressHostsList.noteFulfilled(url, outcome.redirects, outcome.finalUrl);
    };
    // Re-check AFTER resolve: a CONCURRENT essential may have blown the pool while this was in flight.
    if (essential ? this.essentialBudgetExceeded : this.budgetExceeded) {
      countFetched();
      return this.abort(route, url, resourceType, "render_byte_budget", "resource-aborted");
    }
    const cap = essential ? this.input.maxBytes * ESSENTIAL_BUDGET_MULTIPLIER : this.input.maxBytes;
    const poolBytes = essential ? this.essentialBytes : this.bytesFulfilled;
    if (poolBytes + outcome.body.byteLength > cap) {
      if (essential) {
        this.essentialBudgetExceeded = true; // crossing essential: fulfill (counted below)
      } else {
        this.budgetExceeded = true;
        countFetched(); // non-essential crossing: body fetched — count it before aborting
        return this.abort(route, url, resourceType, "render_byte_budget", "resource-aborted");
      }
    }
    countFetched();
    await route.fulfill({
      status: outcome.status,
      body: outcome.body,
      ...(outcome.contentType ? { contentType: outcome.contentType } : {}),
    });
  }

  /** #111: non-GET Tier-3 — OPTIONS preflight → synthesized permissive response; first-party POST → forwarded via FetcherPort (body reserved, released on reject); else aborts. */
  private async handleNonGet(route: PlaywrightRoute, request: PlaywrightRequest, url: string, resourceType: string): Promise<void> {
    // CORS preflight (OPTIONS) for a cross-origin POST: synthesize a permissive first-party response (#111 codex P1).
    if (request.method() === "OPTIONS") {
      const pre = planOptionsPreflight({ resourceType, url, mainRegistrableDomain: this.mainRegistrableDomain });
      if (pre.kind === "abort") return this.abort(route, url, resourceType, pre.reason);
      await route.fulfill({ status: 204, body: new Uint8Array(0), headers: pre.headers });
      return;
    }
    const h = request.headers?.() ?? {};
    // Authorize (gate + Content-Length) BEFORE reading the body — reject an oversized DECLARED body without materializing it (#111 codex P1).
    const auth = authorizePostForward({
      method: request.method(), resourceType, url,
      contentLength: h["content-length"], mainRegistrableDomain: this.mainRegistrableDomain, maxBytes: this.postMaxBytes,
    });
    if (auth.kind === "abort") return this.abort(route, url, resourceType, auth.reason);
    const plan = materializePostForward({ body: request.postDataBuffer?.() ?? null, contentType: h["content-type"], maxBytes: this.postMaxBytes });
    if (plan.kind === "abort") return this.abort(route, url, resourceType, plan.reason);
    if (this.essentialBudgetExceeded) return this.abort(route, url, resourceType, "render_byte_budget", "resource-aborted");
    if (!this.postSemaphore.tryAcquire()) return this.abort(route, url, resourceType, "render_concurrency_limit");
    this.essentialBytes += plan.body.byteLength; // reserve at dispatch; released on reject
    if (this.essentialBytes > this.input.maxBytes * ESSENTIAL_BUDGET_MULTIPLIER) this.essentialBudgetExceeded = true; // crossing reservation marks the pool blown synchronously so concurrent early-checks see it (#111 codex P2)
    try {
      const outcome = await this.fulfiller.resolve(url, resourceType, plan.postInit);
      if (outcome.kind === "reject") {
        this.essentialBytes -= plan.body.byteLength;
        return this.abort(route, url, resourceType, outcome.reject.code, "request-blocked");
      }
      if (this.essentialBudgetExceeded) { // a concurrent POST blew the pool in flight (#111 codex P2)
        // The POST fully egressed (request body + this response) — count both + the host even though
        // we abort the route. (codex R4 P2: was `-= plan.body.byteLength` → released → undercount.)
        this.essentialBytes += outcome.body.byteLength;
        this.egressHostsList.noteFulfilled(url, outcome.redirects, outcome.finalUrl);
        return this.abort(route, url, resourceType, "render_byte_budget", "resource-aborted");
      }
      // The crossing POST marks the pool exceeded but is still fulfilled (aborting mid-load 400s the page).
      if (this.essentialBytes + outcome.body.byteLength > this.input.maxBytes * ESSENTIAL_BUDGET_MULTIPLIER) {
        this.essentialBudgetExceeded = true;
      }
      this.essentialBytes += outcome.body.byteLength;
      this.actions.push({ type: "request-forwarded-post", outcome: "ok", url: safeRenderUrl(url), resourceType, method: "POST", bodyBytes: plan.body.byteLength, responseBytes: outcome.body.byteLength });
      this.egressHostsList.noteFulfilled(url, outcome.redirects, outcome.finalUrl);
      // ACAO:* admits the cross-origin POST response (#111 codex P1). Credentialed CORS (credentials:"include") would need the Origin echoed — known limitation (rare; cookies stripped).
      await route.fulfill({
        status: outcome.status,
        body: outcome.body,
        ...(outcome.contentType ? { contentType: outcome.contentType } : {}),
        headers: CORS_ALLOW_ORIGIN,
      });
    } finally {
      this.postSemaphore.release();
    }
  }

  private async abortBlockedType(route: PlaywrightRoute, url: string, resourceType: string): Promise<void> {
    const blocked = await this.guard.check(url, AbortSignal.timeout(this.input.timeoutMs));
    const reason = blocked?.code ?? `blocked_${resourceType}`;
    await this.abort(route, url, resourceType, reason, "resource-aborted");
  }

  private async abort(route: PlaywrightRoute, url: string, resourceType: string, reason: string, type: RenderAction["type"] = "request-blocked"): Promise<void> {
    this.actions.push({ type, reason, url: safeRenderUrl(url), resourceType });
    await route.abort("blockedbyclient");
  }
}

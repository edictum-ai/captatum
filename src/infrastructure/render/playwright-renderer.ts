import type { RejectResult } from "../../application/ports/fetcher.ts";
import type { ProvenanceError } from "../../domain/result.ts";
import type {
  RenderAction,
  RenderFailure,
  RenderInput,
  RenderOutput,
  RenderPort,
} from "../../application/ports/renderer.ts";
import { streamFromBytes } from "../http/body.ts";
import { P1BrowserUrlGuard, safeRenderUrl, type BrowserUrlGuard } from "./browser-url-guard.ts";
import { RenderRouteState } from "./route-state.ts";
import type {
  PlaywrightBrowser,
  PlaywrightDownload,
  PlaywrightContext,
  PlaywrightEventValue,
  PlaywrightModule,
  PlaywrightPage,
  PlaywrightWebSocket,
  PlaywrightWebSocketRoute,
} from "./playwright-types.ts";

export interface PlaywrightRendererDeps {
  loadPlaywright?: () => Promise<PlaywrightModule>;
  guard?: BrowserUrlGuard;
  /** CDP endpoint for sidecar mode (e.g. "http://localhost:9222"). If set, the renderer connects to a long-lived Chromium in its own container instead of launching one in-process. */
  cdpEndpoint?: string;
  /** Chromium OS sandbox for in-process launch. Default true — the threat model mandates sandbox on; --no-sandbox in-process is only for a sidecar-less transitional deploy. */
  chromiumSandbox?: boolean;
  /** Cap (ms) for the post-load network-idle settle that replaces the old flat 3s sleep. Default 3000. */
  settleMs?: number;
}

export class PlaywrightRenderer implements RenderPort {
  private readonly loadPlaywright: () => Promise<PlaywrightModule>;
  private readonly guard: BrowserUrlGuard;
  private readonly cdpEndpoint?: string;
  private readonly chromiumSandbox: boolean;
  private readonly settleMs: number;
  /** Lazily-connected, reused CDP browser. Connecting per-render would leak a WebSocket every call. */
  private cdpBrowser?: PlaywrightBrowser;

  constructor(deps: PlaywrightRendererDeps = {}) {
    this.loadPlaywright = deps.loadPlaywright ?? defaultLoadPlaywright;
    this.guard = deps.guard ?? new P1BrowserUrlGuard();
    this.cdpEndpoint = deps.cdpEndpoint;
    this.chromiumSandbox = deps.chromiumSandbox ?? true;
    this.settleMs = deps.settleMs ?? 3000;
  }

  async render(input: RenderInput): Promise<RenderOutput> {
    const actions: RenderAction[] = [serviceWorkerAction()];
    const state = new RenderRouteState(input, actions, this.guard);
    let browser: PlaywrightBrowser | undefined;
    let context: PlaywrightContext | undefined;
    let page: PlaywrightPage | undefined;
    let ownsBrowser = false;

    try {
      const playwright = await this.loadPlaywright();
      if (this.cdpEndpoint) {
        // Sidecar mode: connect ONCE to a long-lived Chromium in its own container
        // (blast-radius separation), reuse across renders; never close it here.
        if (!this.cdpBrowser) this.cdpBrowser = await playwright.chromium.connectOverCDP(this.cdpEndpoint);
        browser = this.cdpBrowser;
      } else {
        browser = await playwright.chromium.launch({
          headless: true,
          chromiumSandbox: this.chromiumSandbox,
          env: {},
        });
        ownsBrowser = true;
      }
      context = await browser.newContext({
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      page = await context.newPage();
      state.setMainFrame(page.mainFrame());
      await installPageControls(page, actions, input.timeoutMs);
      await page.route("**/*", (route) => state.handle(route));
      const response = await withTimeout(
        page.goto(input.url, { waitUntil: "domcontentloaded", timeout: input.timeoutMs }),
        input.timeoutMs,
      );
      // Idle-aware settle (replaces a flat 3s sleep): wait for network quiescence,
      // capped at settleMs; never fail if a page holds a long-lived connection.
      await page.waitForLoadState("networkidle", { timeout: this.settleMs }).catch(() => {});
      if (state.fatal) return renderFailure(state.fatal, actions);
      let content = await page.content();
      try {
        const main = page.mainFrame();
        for (const frame of page.frames()) {
          if (frame === main) continue;
          const frameContent = await frame.content();
          if (frameContent.length > 100) content += "\n" + frameContent;
        }
      } catch { /* iframe capture best-effort */ }
      // Advisory byte cap: the rendered HTML is already in memory, so truncate
      // at the cap and keep rendering with a provenance note rather than throwing
      // it away. The fetch-path cap stays a hard reject (a pre-download abuse guard).
      const { bytes, truncated } = capRenderedBytes(content, input.maxBytes);
      const notice: ProvenanceError | undefined = truncated
        ? { code: "max_bytes", message: `Rendered content truncated at ${input.maxBytes} bytes` }
        : undefined;
      return renderSuccess(input, page, response?.status() ?? state.status, bytes, state, notice);
    } catch (error) {
      return renderFailure(state.fatal ?? rejectFromError(error), actions);
    } finally {
      await closeQuietly(page);
      await closeQuietly(context);
      // Only close a browser we launched; the CDP sidecar is shared + long-lived.
      if (ownsBrowser) await closeQuietly(browser);
    }
  }
}

async function installPageControls(
  page: PlaywrightPage,
  actions: RenderAction[],
  timeoutMs: number,
): Promise<void> {
  page.setDefaultTimeout?.(timeoutMs);
  page.setDefaultNavigationTimeout?.(timeoutMs);
  page.on("download", (value) => blockDownload(value, actions));
  if (page.routeWebSocket) {
    await page.routeWebSocket("**/*", (socket) => closeWebSocket(socket, actions));
  } else {
    page.on("websocket", (value) => closeLegacyWebSocket(value, actions));
  }
}

function blockDownload(value: PlaywrightEventValue, actions: RenderAction[]): void {
  const download = value as PlaywrightDownload;
  actions.push({
    type: "download-blocked",
    reason: "downloads disabled",
    url: safeRenderUrl(download.url()),
  });
  void download.cancel?.();
}

function closeLegacyWebSocket(value: PlaywrightEventValue, actions: RenderAction[]): void {
  const socket = value as PlaywrightWebSocket;
  actions.push({ type: "websocket-closed", reason: "websockets disabled", url: safeRenderUrl(socket.url()) });
  void socket.close?.();
}

async function closeWebSocket(socket: PlaywrightWebSocketRoute, actions: RenderAction[]): Promise<void> {
  actions.push({ type: "websocket-closed", reason: "websockets disabled", url: safeRenderUrl(socket.url()) });
  await socket.close();
}

function renderSuccess(
  input: RenderInput,
  page: PlaywrightPage,
  status: number,
  bytes: Uint8Array,
  state: RenderRouteState,
  notice?: ProvenanceError,
): RenderOutput {
  return {
    rendered: true,
    fetchResult: {
      status,
      finalUrl: state.finalUrl || safeRenderUrl(page.url()) || input.url,
      redirects: state.redirects,
      bodyStream: streamFromBytes(bytes),
      contentType: "text/html; charset=utf-8",
      bytes: bytes.byteLength,
    },
    actions: state.actions,
    ...(notice ? { notice } : {}),
  };
}

/**
 * UTF-8-safe truncation that never exceeds the cap. Encode once, then cut at the
 * largest character boundary at or below maxBytes by walking back past any
 * trailing continuation bytes (0x80–0xBF) — so the slice never splits a
 * multibyte sequence and is always valid UTF-8.
 */
function capRenderedBytes(content: string, maxBytes: number): { bytes: Uint8Array; truncated: boolean } {
  const full = new TextEncoder().encode(content);
  if (full.byteLength <= maxBytes) return { bytes: full, truncated: false };
  let cut = maxBytes;
  while (cut > 0 && (full[cut] & 0xc0) === 0x80) cut -= 1;
  return { bytes: full.subarray(0, cut), truncated: true };
}

function renderFailure(rejected: RejectResult, actions: RenderAction[]): RenderFailure {
  return { ...rejected, rendered: false, actions };
}

async function defaultLoadPlaywright(): Promise<PlaywrightModule> {
  try {
    return await import("playwright") as unknown as PlaywrightModule;
  } catch {
    throw new RenderError("render_unavailable", "Playwright is not installed");
  }
}

class RenderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RenderError";
    this.code = code;
  }
}

function rejectFromError(error: unknown): RejectResult {
  if (error instanceof RenderError) {
    return { rejected: true, code: error.code, message: error.message };
  }
  if (error instanceof Error && error.message === "render_timeout") {
    return { rejected: true, code: "timeout", message: "Render timed out" };
  }
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`captatum render error: ${detail}\n`);
  return { rejected: true, code: "render_error", message: `Tier-3 render failed: ${detail}` };
}

function serviceWorkerAction(): RenderAction {
  return { type: "service-workers-disabled", reason: "context serviceWorkers=block" };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("render_timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function closeQuietly(closeable: { close(): Promise<void> } | undefined): Promise<void> {
  try {
    await closeable?.close();
  } catch {
    // Best-effort browser cleanup only.
  }
}

import type { RejectResult } from "../../application/ports/fetcher.ts";
import type {
  RenderAction,
  RenderFailure,
  RenderInput,
  RenderOutput,
  RenderPort,
} from "../../application/ports/renderer.ts";
import { streamFromBytes } from "../http/body.ts";
import { P1BrowserUrlGuard, safeRenderUrl, type BrowserUrlGuard } from "./browser-url-guard.ts";
import { maxBytesReject, RenderRouteState } from "./route-state.ts";
import type {
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
}

export class PlaywrightRenderer implements RenderPort {
  private readonly loadPlaywright: () => Promise<PlaywrightModule>;
  private readonly guard: BrowserUrlGuard;

  constructor(deps: PlaywrightRendererDeps = {}) {
    this.loadPlaywright = deps.loadPlaywright ?? defaultLoadPlaywright;
    this.guard = deps.guard ?? new P1BrowserUrlGuard();
  }

  async render(input: RenderInput): Promise<RenderOutput> {
    const actions: RenderAction[] = [serviceWorkerAction()];
    const state = new RenderRouteState(input, actions, this.guard);
    let browser: Awaited<ReturnType<PlaywrightModule["chromium"]["launch"]>> | undefined;
    let context: PlaywrightContext | undefined;
    let page: PlaywrightPage | undefined;

    try {
      const playwright = await this.loadPlaywright();
      browser = await playwright.chromium.launch({
        headless: true,
        chromiumSandbox: false,
        env: {},
      });
      context = await browser.newContext({
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      page = await context.newPage();
      await installPageControls(page, actions, input.timeoutMs);
      await page.route("**/*", (route) => state.handle(route));
      const response = await withTimeout(
        page.goto(input.url, { waitUntil: "domcontentloaded", timeout: input.timeoutMs }),
        input.timeoutMs,
      );
      if (state.fatal) return renderFailure(state.fatal, actions);
      const content = await page.content();
      const bytes = new TextEncoder().encode(content);
      if (bytes.byteLength > input.maxBytes) {
        return renderFailure(maxBytesReject(), actions);
      }
      return renderSuccess(input, page, response?.status() ?? state.status, bytes, state);
    } catch (error) {
      return renderFailure(state.fatal ?? rejectFromError(error), actions);
    } finally {
      await closeQuietly(page);
      await closeQuietly(context);
      await closeQuietly(browser);
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
  };
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
  return { rejected: true, code: "render_error", message: "Tier-3 render failed" };
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

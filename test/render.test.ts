import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetcherOptions, FetcherPort, FetcherResult, RejectResult } from "../src/application/ports/fetcher.ts";
import type { BrowserUrlGuard } from "../src/infrastructure/render/index.ts";
import { PlaywrightRenderer, createRenderer } from "../src/infrastructure/render/index.ts";

test("renderer lazy-loads Playwright only when render is invoked", async () => {
  const harness = new BrowserHarness();
  const renderer = new PlaywrightRenderer({ loadPlaywright: harness.load });

  assert.equal(harness.loadCalls, 0);
  await renderer.render(renderInput(new FakeFetcher()));

  assert.equal(harness.loadCalls, 1);
});

test("renderer launches sandboxed context with service workers and downloads disabled", async () => {
  const harness = new BrowserHarness({
    downloadUrl: "https://public.test/file.zip",
    websocketUrl: "wss://public.test/socket",
  });
  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(new FakeFetcher()));

  assert.equal(result.rendered, true);
  assert.deepEqual(harness.launchOptions.env, {});
  assert.equal(harness.launchOptions.chromiumSandbox, true);
  assert.deepEqual(harness.contextOptions, {
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  assert.equal(harness.downloadCanceled, true);
  assert.equal(harness.websocketClosed, true);
  assert.deepEqual(result.actions.map((action) => action.type), [
    "service-workers-disabled",
    "websocket-closed",
    "download-blocked",
  ]);
});

test("renderer fulfills the public navigation through the fetcher and blocks private subresources", async () => {
  const navUrl = "https://public.test/";
  const privateUrl = "http://169.254.169.254/latest.js";
  // The fetcher is now the SSRF enforcer: every non-aborted request resolves
  // through fetchGuarded (IP-pinned, per-hop redirect revalidation). A private
  // subresource is rejected here, not by a name-only browser guard.
  const fetcher = new FakeFetcher({
    [privateUrl]: {
      rejected: true,
      code: "private_address",
      message: "Host resolves to a private or reserved address",
    },
  });
  const harness = new BrowserHarness({
    requests: [request(navUrl, "document", true), request(privateUrl, "script")],
  });

  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(fetcher));

  assert.equal(result.rendered, true);
  // The navigation is fulfilled with the fetcher's bytes — never route.continue()'d,
  // so Chromium makes no egress of its own. Every request routed through the fetcher.
  assert.equal(harness.routes[0]?.fulfilled, true);
  assert.equal(harness.routes[0]?.continued, false);
  assert.equal(harness.routes[0]?.body, "<html>ok</html>");
  assert.deepEqual(fetcher.calls.map((call) => call.url), [navUrl, privateUrl]);
  assert.equal(harness.routes.at(-1)?.aborted, true);
  assert.deepEqual(result.actions.at(-1), {
    type: "request-blocked",
    reason: "private_address",
    url: "http://169.254.169.254/latest.js",
    resourceType: "script",
  });
});

test("renderer fails closed when a navigation redirects (via the fetcher) to a private host", async () => {
  const navUrl = "https://public.test/redirect";
  // fetchGuarded follows redirects internally and rejects at the private hop;
  // the browser never sees the redirect, so Playwright's continue-redirect FSM
  // (TIER3-NAV-1) is out of the egress path entirely.
  const fetcher = new FakeFetcher({
    [navUrl]: {
      rejected: true,
      code: "private_address",
      message: "Redirect target resolves to a private or reserved address",
    },
  });
  const harness = new BrowserHarness({
    requests: [request(navUrl, "document", true)],
  });

  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(fetcher));

  assert.equal(result.rendered, false);
  assert.equal(result.code, "private_address");
  assert.equal(harness.routes[0]?.aborted, true);
});

test("renderer fulfills a navigation served without Content-Type as text/html (not a download)", async () => {
  const navUrl = "https://public.test/";
  // A navigation whose response carries no Content-Type must still render.
  // Defaulting to application/octet-stream makes Chromium treat it as a download
  // (page.goto throws) — a regression vs route.continue()'s MIME sniffing.
  const fetcher = new FakeFetcher({
    [navUrl]: { ...fetchResult("<html><body>ok</body></html>", navUrl), contentType: "" },
  });
  const harness = new BrowserHarness({ requests: [request(navUrl, "document", true)] });

  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(fetcher));

  assert.equal(result.rendered, true);
  assert.equal(harness.routes[0]?.fulfilled, true);
  assert.equal(harness.routes[0]?.contentType, "text/html; charset=utf-8");
});

test("renderer defaults a header-less script to text/javascript (Chromium won't execute text/html)", async () => {
  const navUrl = "https://public.test/";
  const scriptUrl = "https://cdn.test/app.js";
  // A script whose CDN omits Content-Type must be served as a JS MIME — defaulting
  // to text/html (as a global default would) makes Chromium refuse to run it.
  const fetcher = new FakeFetcher({
    [scriptUrl]: { ...fetchResult("document.body.dataset.app='ran';", scriptUrl), contentType: "" },
  });
  const harness = new BrowserHarness({
    requests: [request(navUrl, "document", true), request(scriptUrl, "script")],
  });

  await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(fetcher));

  assert.equal(harness.routes.at(-1)?.fulfilled, true);
  assert.equal(harness.routes.at(-1)?.contentType, "text/javascript");
});

test("renderer keeps the main-frame finalUrl; an iframe navigation does not overwrite it", async () => {
  const mainUrl = "https://public.test/";
  const iframeUrl = "https://embed.test/frame";
  // Both are navigations; the iframe is a subframe (mainFrame=false). Without the
  // frame-based guard the iframe would overwrite finalUrl.
  const fetcher = new FakeFetcher({
    [iframeUrl]: fetchResult("<html>iframe</html>", iframeUrl),
  });
  const harness = new BrowserHarness({
    requests: [request(mainUrl, "document", true), request(iframeUrl, "document", true, false)],
  });

  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(fetcher));

  assert.equal(result.rendered, true);
  if (!result.rendered) throw new Error("expected render success");
  assert.equal(result.fetchResult.finalUrl, mainUrl);
});

test("renderer updates finalUrl on a later main-frame navigation (same-tab client-side nav)", async () => {
  const firstUrl = "https://public.test/first";
  const canonicalUrl = "https://public.test/canonical";
  // A page that performs a client-side same-tab navigation after the first load
  // (location.href = '/canonical') is a SECOND main-frame navigation; provenance
  // must track it, not stay stuck on the first.
  const fetcher = new FakeFetcher({
    [canonicalUrl]: fetchResult("<html>canonical body</html>", canonicalUrl),
  });
  const harness = new BrowserHarness({
    requests: [request(firstUrl, "document", true), request(canonicalUrl, "document", true)],
  });

  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(fetcher));

  assert.equal(result.rendered, true);
  if (!result.rendered) throw new Error("expected render success");
  assert.equal(result.fetchResult.finalUrl, canonicalUrl);
});

test("renderer tolerates a navigation request whose frame() throws (early navigation)", async () => {
  const navUrl = "https://public.test/early";
  // Per Playwright docs, request.frame() throws for a navigation issued before
  // its frame is created; isMainFrame must swallow that so the route still
  // resolves instead of turning the render into render_error.
  const harness = new BrowserHarness({
    requests: [{
      url: navUrl, resourceType: "document", navigation: true, mainFrame: true,
      method: "GET", frameThrows: true,
    }],
  });

  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(new FakeFetcher()));

  assert.equal(result.rendered, true);
  assert.equal(harness.routes[0]?.fulfilled, true);
});

test("adblock never aborts the main-frame nav or first-party subresources of a vendor apex (codex SF-4)", async () => {
  // amplitude.com is in the adblock list, but when it IS the fetched page its
  // top-level document and own (sub)domain subresources must still load; only
  // third-party tracker subresources are aborted.
  const harness = new BrowserHarness({
    requests: [
      request("https://amplitude.com/", "document", true, true),
      request("https://cdn.amplitude.com/assets/app.js", "script", false, true),
      request("https://doubleclick.net/ad.js", "script", false, true),
    ],
  });
  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(new FakeFetcher(), { url: "https://amplitude.com/" }));

  assert.equal(result.rendered, true);
  assert.equal(harness.routes[0]?.fulfilled, true, "main-frame nav to vendor apex fulfilled (not adblocked)");
  assert.equal(harness.routes[1]?.fulfilled, true, "first-party subresource fulfilled (not adblocked)");
  assert.equal(harness.routes[2]?.aborted, true, "third-party tracker subresource aborted");
});

test("renderer checks private image URLs before aborting blocked body types", async () => {  const imageUrl = "http://127.0.0.1/pixel.png";
  const guard = new FakeGuard({
    [imageUrl]: { rejected: true, code: "private_address", message: "blocked" },
  });
  const harness = new BrowserHarness({
    requests: [
      request("https://public.test/", "document", true),
      request(imageUrl, "image"),
    ],
  });

  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard })
    .render(renderInput(new FakeFetcher()));

  assert.equal(result.rendered, true);
  assert.ok(guard.calls.includes(imageUrl));
  assert.equal(harness.routes.at(-1)?.aborted, true);
  assert.deepEqual(result.actions.at(-1), {
    type: "resource-aborted",
    reason: "private_address",
    url: "http://127.0.0.1/pixel.png",
    resourceType: "image",
  });
});

test("renderer truncates rendered HTML at the byte cap (advisory, not fatal)", async () => {
  const harness = new BrowserHarness({ content: "<main>too large to fit here</main>" });
  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(new FakeFetcher(), { maxBytes: 8 }));

  // Advisory: a rendered page that exceeds the cap is truncated and returned
  // with a max_bytes provenance note, not rejected wholesale (the bytes are
  // already in memory; throwing them away would waste the whole render).
  assert.equal(result.rendered, true);
  if (!result.rendered) throw new Error("expected render success");
  assert.equal(result.notice?.code, "max_bytes");
  assert.ok(result.fetchResult.bytes <= 8, `expected <= 8 bytes, got ${result.fetchResult.bytes}`);
  assert.equal(harness.browserClosed, true);
});

test("render byte budget aborts non-essential types but never essential scripts/fetches (cerebralvalley clerk.js)", async () => {
  // Aborting a script/fetch mid-load crashes the client app (Next.js shows
  // "Application error: a client-side exception has occurred"). Essential render
  // types (script/fetch/xhr/document) are exempt from the cumulative budget; each
  // is still per-response maxBytes-capped by the fetcher.
  const fetcher = new FakeFetcher({
    "https://public.test/a.css": fetchResult("x".repeat(80), "https://public.test/a.css"),
    "https://public.test/b.css": fetchResult("y".repeat(50), "https://public.test/b.css"),
    "https://public.test/app.js": fetchResult("z".repeat(60), "https://public.test/app.js"),
    "https://public.test/flags": fetchResult("{}{}{}{}{}", "https://public.test/flags"),
  });
  const harness = new BrowserHarness({
    requests: [
      request("https://public.test/", "document", true), // nav 11 bytes → total 11
      request("https://public.test/a.css", "stylesheet"), // 80 → total 91 (fulfilled)
      request("https://public.test/b.css", "stylesheet"), // 50 → 141 > 100 → aborted (non-essential), budget exceeded
      request("https://public.test/app.js", "script"), // essential → fulfilled despite budget
      request("https://public.test/flags", "fetch"), // essential → fulfilled despite budget
    ],
  });
  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(fetcher, { maxBytes: 100 }));

  assert.equal(result.rendered, true);
  assert.equal(harness.routes[0]?.fulfilled, true, "nav fulfilled");
  assert.equal(harness.routes[1]?.fulfilled, true, "stylesheet under budget fulfilled");
  assert.equal(harness.routes[2]?.aborted, true, "stylesheet over budget aborted (non-essential)");
  assert.equal(harness.routes[3]?.fulfilled, true, "script fulfilled over budget (essential — aborting crashes the app)");
  assert.equal(harness.routes[4]?.fulfilled, true, "fetch fulfilled over budget (essential)");
});

test("render byte budget caps the ESSENTIAL pool too (DoS bound): crossing script fulfilled, later scripts aborted", async () => {
  // Essentials get their own maxBytes pool so a real app's scripts load, but the pool
  // is still bounded — the script that crosses the cap is fulfilled (aborting it
  // mid-load crashes the app), and every essential AFTER that is aborted. This keeps
  // a flooding SPA from consuming unbounded bytes via script/fetch.
  const fetcher = new FakeFetcher({
    "https://public.test/s1.js": fetchResult("a".repeat(60), "https://public.test/s1.js"),
    "https://public.test/s2.js": fetchResult("b".repeat(60), "https://public.test/s2.js"),
    "https://public.test/s3.js": fetchResult("c".repeat(60), "https://public.test/s3.js"),
    "https://public.test/s4.js": fetchResult("d".repeat(60), "https://public.test/s4.js"),
  });
  const harness = new BrowserHarness({
    requests: [
      request("https://public.test/s1.js", "script"), // 60 → pool 60 (< 100) fulfilled
      request("https://public.test/s2.js", "script"), // 60 → 120 > 100, crossing essential → fulfilled, pool exceeded
      request("https://public.test/s3.js", "script"), // essential pool exceeded → aborted
      request("https://public.test/s4.js", "script"), // aborted
    ],
  });
  await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(fetcher, { maxBytes: 100 }));

  assert.equal(harness.routes[0]?.fulfilled, true, "s1 under the essential pool fulfilled");
  assert.equal(harness.routes[1]?.fulfilled, true, "s2 crossing the cap fulfilled (essential — aborting crashes the app)");
  assert.equal(harness.routes[2]?.aborted, true, "s3 after the essential pool is blown aborted (DoS bound)");
  assert.equal(harness.routes[3]?.aborted, true, "s4 aborted");
});

test("renderer concatenates captured iframe content into the rendered HTML", async () => {
  const harness = new BrowserHarness({
    content: "<html><head><title>Host Page</title></head><body>host body text</body></html>",
    extraFrameContent: '<script type="application/ld+json">{"@type":"JobPosting","title":"Embedded Job"}</script><p>embedded widget body</p>',
  });
  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(new FakeFetcher()));

  assert.equal(result.rendered, true);
  if (!result.rendered) throw new Error("expected render success");
  const text = await new Response(result.fetchResult.bodyStream).text();
  assert.ok(text.includes("host body text"), "host page content present");
  assert.ok(text.includes("Embedded Job"), "iframe JSON-LD captured");
  assert.ok(text.includes("embedded widget body"), "iframe body captured");
});

test("renderer byte-cap truncation respects UTF-8 boundaries for multibyte content", async () => {
  // "aaaaa😀" is 9 bytes (5 ASCII + a 4-byte emoji); a 60-byte cap lands mid-emoji.
  const harness = new BrowserHarness({ content: "aaaaa😀".repeat(50) });
  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard: new FakeGuard({}) })
    .render(renderInput(new FakeFetcher(), { maxBytes: 60 }));

  assert.equal(result.rendered, true);
  if (!result.rendered) throw new Error("expected render success");
  assert.equal(result.notice?.code, "max_bytes");
  assert.ok(result.fetchResult.bytes <= 60, `expected <= 60 bytes, got ${result.fetchResult.bytes}`);
  // Truncated bytes must decode as valid UTF-8 — no dangling partial sequence.
  const decoded = await new Response(result.fetchResult.bodyStream).text();
  assert.equal(Buffer.from(decoded, "utf8").toString("utf8"), decoded);
});

test("renderer returns timeout and closes the browser on stalled navigation", async () => {
  const harness = new BrowserHarness({ neverResolve: true });
  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load })
    .render(renderInput(new FakeFetcher(), { timeoutMs: 5 }));

  assert.equal(result.rendered, false);
  assert.equal(result.code, "timeout");
  assert.equal(harness.browserClosed, true);
});

test("renderer connects to a CDP sidecar and does not close the shared browser", async () => {
  const harness = new BrowserHarness();
  const renderer = new PlaywrightRenderer({
    loadPlaywright: harness.load,
    guard: new FakeGuard({}),
    cdpEndpoint: "http://localhost:9222",
  });
  const result = await renderer.render(renderInput(new FakeFetcher()));

  // Sidecar mode: connect over CDP (not launch), and never close the long-lived
  // shared browser — only the per-render context+page.
  assert.equal(result.rendered, true);
  assert.equal(harness.cdpEndpoint, "http://localhost:9222");
  assert.equal(harness.launchCalled, false);
  assert.equal(harness.browserClosed, false);
});

interface ScriptedRequest {
  url: string;
  resourceType: string;
  navigation: boolean;
  mainFrame: boolean;
  method: string;
  frameThrows?: boolean;
}

class BrowserHarness {
  loadCalls = 0;
  launchCalled = false;
  launchOptions: Record<string, unknown> = {};
  cdpEndpoint?: string;
  contextOptions: Record<string, unknown> = {};
  routes: FakeRoute[] = [];
  browserClosed = false;
  downloadCanceled = false;
  websocketClosed = false;
  // Stable frame sentinels so request.frame() === mainFrame distinguishes the
  // top-level document from an iframe navigation (matches page.mainFrame()).
  readonly mainFrame = {};
  readonly subFrame = {};
  private readonly options: {
    requests?: ScriptedRequest[];
    content?: string;
    extraFrameContent?: string;
    downloadUrl?: string;
    websocketUrl?: string;
    neverResolve?: boolean;
  };
  private routeHandler?: (route: FakeRoute) => Promise<void> | void;
  private websocketHandler?: (socket: FakeWebSocket) => Promise<void> | void;
  private downloadHandler?: (download: FakeDownload) => void;

  constructor(options: BrowserHarness["options"] = {}) {
    this.options = options;
  }

  load = async () => {
    this.loadCalls += 1;
    return {
      chromium: {
        launch: async (options: Record<string, unknown>) => {
          this.launchCalled = true;
          this.launchOptions = options;
          return this.browser();
        },
        connectOverCDP: async (endpoint: string) => {
          this.cdpEndpoint = endpoint;
          return this.browser();
        },
      },
    };
  };

  private browser() {
    return {
      newContext: async (options: Record<string, unknown>) => {
        this.contextOptions = options;
        return { newPage: async () => this.page(), close: async () => {} };
      },
      close: async () => {
        this.browserClosed = true;
      },
    };
  }

  private page() {
    // mainFrame is the harness instance sentinel (=== the detector's mainFrame);
    // extraFrame is a distinct object so the renderer's iframe loop (skip
    // frame === main) captures it when configured.
    const extraFrame = this.options.extraFrameContent !== undefined
      ? { content: async () => this.options.extraFrameContent as string }
      : undefined;
    return {
      route: async (_pattern: string, handler: (route: FakeRoute) => Promise<void> | void) => {
        this.routeHandler = handler;
      },
      routeWebSocket: async (
        _pattern: string,
        handler: (socket: FakeWebSocket) => Promise<void> | void,
      ) => {
        this.websocketHandler = handler;
      },
      on: (event: "download", handler: (download: FakeDownload) => void) => {
        if (event === "download") this.downloadHandler = handler;
      },
      setDefaultTimeout: (_timeoutMs: number) => {},
      setDefaultNavigationTimeout: (_timeoutMs: number) => {},
      goto: async (url: string) => await this.goto(url),
      // The real renderer waits for client-side widgets after DOMContentLoaded
      // (commit 9bba8aa) and captures iframe content (commit d50a3c9).
      waitForTimeout: async (_ms: number) => {},
      waitForLoadState: async (_state: string, _options?: { timeout?: number }) => {},
      mainFrame: () => this.mainFrame,
      frames: () => (extraFrame ? [this.mainFrame, extraFrame] : [this.mainFrame]),
      content: async () => this.options.content ?? "<main>rendered</main>",
      url: () => "https://public.test/",
      close: async () => {},
    };
  }

  private async goto(url: string) {
    if (this.options.neverResolve) return await new Promise<never>(() => {});
    const requests = this.options.requests ?? [request(url, "document", true)];
    for (const scripted of requests) {
      const route = new FakeRoute(scripted, this);
      this.routes.push(route);
      await this.routeHandler?.(route);
    }
    if (this.options.websocketUrl && this.websocketHandler) {
      await this.websocketHandler(new FakeWebSocket(this.options.websocketUrl, this));
    }
    if (this.options.downloadUrl && this.downloadHandler) {
      this.downloadHandler(new FakeDownload(this.options.downloadUrl, this));
    }
    return { status: () => this.routes[0]?.status ?? 200 };
  }
}

class FakeRoute {
  aborted = false;
  continued = false;
  fulfilled = false;
  status = 0;
  body = "";
  contentType?: string;
  readonly scripted: ScriptedRequest;
  private readonly harness: BrowserHarness;

  constructor(scripted: ScriptedRequest, harness: BrowserHarness) {
    this.scripted = scripted;
    this.harness = harness;
  }

  request() {
    return {
      url: () => this.scripted.url,
      method: () => this.scripted.method,
      resourceType: () => this.scripted.resourceType,
      isNavigationRequest: () => this.scripted.navigation,
      frame: () => {
        // Per Playwright docs, request.frame() throws for a navigation issued
        // before its frame is created.
        if (this.scripted.frameThrows) throw new Error("frame not created yet");
        return this.scripted.mainFrame ? this.harness.mainFrame : this.harness.subFrame;
      },
    };
  }

  async fulfill(options: { status: number; body?: Uint8Array; contentType?: string }): Promise<void> {
    this.fulfilled = true;
    this.status = options.status;
    this.contentType = options.contentType;
    this.body = options.body ? new TextDecoder().decode(options.body) : "";
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  async continue(): Promise<void> {
    this.continued = true;
  }
}

class FakeDownload {
  readonly value: string;
  private readonly harness: BrowserHarness;

  constructor(value: string, harness: BrowserHarness) {
    this.value = value;
    this.harness = harness;
  }

  url(): string {
    return this.value;
  }

  async cancel(): Promise<void> {
    this.harness.downloadCanceled = true;
  }
}

class FakeWebSocket {
  readonly value: string;
  private readonly harness: BrowserHarness;

  constructor(value: string, harness: BrowserHarness) {
    this.value = value;
    this.harness = harness;
  }

  url(): string {
    return this.value;
  }

  async close(): Promise<void> {
    this.harness.websocketClosed = true;
  }
}

class FakeFetcher implements FetcherPort {
  readonly calls: Array<{ url: string; opts: FetcherOptions }> = [];
  private readonly results: Record<string, FetcherResult | RejectResult>;

  constructor(results: Record<string, FetcherResult | RejectResult> = {}) {
    this.results = results;
  }

  async fetchGuarded(url: string, opts: FetcherOptions): Promise<FetcherResult | RejectResult> {
    this.calls.push({ url, opts });
    return this.results[url] ?? fetchResult("<html>ok</html>", url);
  }
}

class FakeGuard implements BrowserUrlGuard {
  readonly calls: string[] = [];
  private readonly results: Record<string, RejectResult>;

  constructor(results: Record<string, RejectResult> = {}) {
    this.results = results;
  }

  async check(url: string): Promise<RejectResult | null> {
    this.calls.push(url);
    return this.results[url] ?? null;
  }
}

function renderInput(
  fetcher: FetcherPort,
  overrides: Partial<{ url: string; maxBytes: number; timeoutMs: number }> = {},
) {
  return {
    url: overrides.url ?? "https://public.test/",
    maxBytes: overrides.maxBytes ?? 4096,
    timeoutMs: overrides.timeoutMs ?? 100,
    maxHops: 5,
    fetcher,
  };
}

function request(url: string, resourceType: string, navigation = false, mainFrame = true): ScriptedRequest {
  return { url, resourceType, navigation, mainFrame, method: "GET" };
}

function fetchResult(html: string, finalUrl: string): FetcherResult {
  const bytes = new TextEncoder().encode(html);
  return {
    status: 200,
    finalUrl,
    redirects: [],
    bodyStream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    contentType: "text/html; charset=utf-8",
    bytes: bytes.byteLength,
  };
}

test("createRenderer degrades to render-unavailable for hosted flavor with no sidecar", async () => {
  // Hosted never launches an in-process browser (threat model): no CDP sidecar =>
  // render-unavailable, NOT an in-process launch (which would be render_error when
  // no browser binary is present, e.g. the published gateway image).
  const prevFlavor = process.env.CAPTATUM_FLAVOR;
  const prevCdp = process.env.CAPTATUM_BROWSER_CDP_ENDPOINT;
  process.env.CAPTATUM_FLAVOR = "hosted";
  delete process.env.CAPTATUM_BROWSER_CDP_ENDPOINT;
  try {
    const renderer = createRenderer();
    const out = await renderer.render(renderInput(new FakeFetcher()));
    assert.equal(out.rendered, false);
    assert.equal((out as { code?: string }).code, "render_unavailable");
  } finally {
    if (prevFlavor === undefined) delete process.env.CAPTATUM_FLAVOR;
    else process.env.CAPTATUM_FLAVOR = prevFlavor;
    if (prevCdp === undefined) delete process.env.CAPTATUM_BROWSER_CDP_ENDPOINT;
    else process.env.CAPTATUM_BROWSER_CDP_ENDPOINT = prevCdp;
  }
});

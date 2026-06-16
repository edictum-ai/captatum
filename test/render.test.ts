import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetcherOptions, FetcherPort, FetcherResult, RejectResult } from "../src/application/ports/fetcher.ts";
import type { BrowserUrlGuard } from "../src/infrastructure/render/index.ts";
import { PlaywrightRenderer } from "../src/infrastructure/render/index.ts";

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
  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load })
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

test("renderer routes private subresources through guarded fetch and blocks them", async () => {
  const privateUrl = "http://169.254.169.254/latest.js";
  const fetcher = new FakeFetcher({
    [privateUrl]: {
      rejected: true,
      code: "private_address",
      message: "Host resolves to a private or reserved address",
    },
  });
  const harness = new BrowserHarness({
    requests: [
      request("https://public.test/", "document", true),
      request(privateUrl, "script"),
    ],
  });

  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load })
    .render(renderInput(fetcher));

  assert.equal(result.rendered, true);
  assert.deepEqual(fetcher.calls.map((call) => call.url), [
    "https://public.test/",
    privateUrl,
  ]);
  assert.equal(harness.routes.at(-1)?.aborted, true);
  assert.deepEqual(result.actions.at(-1), {
    type: "request-blocked",
    reason: "private_address",
    url: "http://169.254.169.254/latest.js",
    resourceType: "script",
  });
});

test("renderer checks private image URLs before aborting blocked body types", async () => {
  const imageUrl = "http://127.0.0.1/pixel.png";
  const guard = new FakeGuard({
    [imageUrl]: { rejected: true, code: "private_address", message: "blocked" },
  });
  const fetcher = new FakeFetcher();
  const harness = new BrowserHarness({
    requests: [
      request("https://public.test/", "document", true),
      request(imageUrl, "image"),
    ],
  });

  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load, guard })
    .render(renderInput(fetcher));

  assert.equal(result.rendered, true);
  assert.deepEqual(guard.calls, [imageUrl]);
  assert.deepEqual(fetcher.calls.map((call) => call.url), ["https://public.test/"]);
  assert.equal(harness.routes.at(-1)?.aborted, true);
  assert.deepEqual(result.actions.at(-1), {
    type: "resource-aborted",
    reason: "private_address",
    url: "http://127.0.0.1/pixel.png",
    resourceType: "image",
  });
});

test("renderer enforces rendered HTML byte cap", async () => {
  const harness = new BrowserHarness({ content: "<main>too large</main>" });
  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load })
    .render(renderInput(new FakeFetcher(), { maxBytes: 8 }));

  assert.equal(result.rendered, false);
  assert.equal(result.code, "max_bytes");
  assert.equal(harness.browserClosed, true);
});

test("renderer returns timeout and closes the browser on stalled navigation", async () => {
  const harness = new BrowserHarness({ neverResolve: true });
  const result = await new PlaywrightRenderer({ loadPlaywright: harness.load })
    .render(renderInput(new FakeFetcher(), { timeoutMs: 5 }));

  assert.equal(result.rendered, false);
  assert.equal(result.code, "timeout");
  assert.equal(harness.browserClosed, true);
});

interface ScriptedRequest {
  url: string;
  resourceType: string;
  navigation: boolean;
  method: string;
}

class BrowserHarness {
  loadCalls = 0;
  launchOptions: Record<string, unknown> = {};
  contextOptions: Record<string, unknown> = {};
  routes: FakeRoute[] = [];
  browserClosed = false;
  downloadCanceled = false;
  websocketClosed = false;
  private readonly options: {
    requests?: ScriptedRequest[];
    content?: string;
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
          this.launchOptions = options;
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
      content: async () => this.options.content ?? "<main>rendered</main>",
      url: () => "https://public.test/",
      close: async () => {},
    };
  }

  private async goto(url: string) {
    if (this.options.neverResolve) return await new Promise<never>(() => {});
    const requests = this.options.requests ?? [request(url, "document", true)];
    for (const scripted of requests) {
      const route = new FakeRoute(scripted);
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
  status = 0;
  readonly scripted: ScriptedRequest;

  constructor(scripted: ScriptedRequest) {
    this.scripted = scripted;
  }

  request() {
    return {
      url: () => this.scripted.url,
      method: () => this.scripted.method,
      resourceType: () => this.scripted.resourceType,
      isNavigationRequest: () => this.scripted.navigation,
    };
  }

  async fulfill(options: { status: number }): Promise<void> {
    this.status = options.status;
  }

  async abort(): Promise<void> {
    this.aborted = true;
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

  constructor(results: Record<string, RejectResult>) {
    this.results = results;
  }

  async check(url: string): Promise<RejectResult | null> {
    this.calls.push(url);
    return this.results[url] ?? null;
  }
}

function renderInput(
  fetcher: FetcherPort,
  overrides: Partial<{ maxBytes: number; timeoutMs: number }> = {},
) {
  return {
    url: "https://public.test/",
    maxBytes: overrides.maxBytes ?? 4096,
    timeoutMs: overrides.timeoutMs ?? 100,
    maxHops: 5,
    fetcher,
  };
}

function request(url: string, resourceType: string, navigation = false): ScriptedRequest {
  return { url, resourceType, navigation, method: "GET" };
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

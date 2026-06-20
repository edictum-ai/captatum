import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetcherOptions, FetcherPort, FetcherResult, RejectResult } from "../src/application/ports/fetcher.ts";
import type { ClockPort } from "../src/application/ports/clock.ts";
import type {
  RenderInput,
  RenderOutput,
  RenderPort,
} from "../src/application/ports/renderer.ts";
import type { TransformInput, TransformPort, TransformResult } from "../src/application/ports/transformer.ts";
import { createSmartFetchUseCase } from "../src/application/use-cases/smart-fetch.ts";
import type { HtmlExtraction, HtmlExtractionInput } from "../src/application/use-cases/tier1-extract.ts";
import { SmartFetchInputError } from "../src/application/use-cases/smart-fetch-input.ts";

test("successful Tier-1 fetch plus extraction returns Result provenance", async () => {
  const html = "<html><title>ignored</title><body>Hello</body></html>";
  const fetcher = new FakeFetcher(fetchResult({
    html,
    finalUrl: "https://example.test/final",
    redirects: [{ url: "https://example.test/final", status: 301 }],
  }));
  const extractor = new FakeExtractor(extraction({
    title: "Extracted Title",
    text: "Clean extracted content",
    structured: { og: { "og:title": "Extracted Title" } },
  }));

  const result = await createSmartFetchUseCase({
    fetcher,
    extractHtml: extractor.extract,
    clock: new FakeClock([100, 112, 115, 115]),
  }).execute({
    url: "http://example.test/start#secret",
    output: "raw",
    maxBytes: 1234,
    timeoutMs: 456,
  }, { fetchedAt: "2026-06-16T00:00:00.000Z" });

  assert.deepEqual(fetcher.calls, [{
    url: "https://example.test/start",
    opts: { maxBytes: 1234, timeoutMs: 456, maxHops: 5 },
  }]);
  assert.equal(extractor.calls[0]?.html, html);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.url, "https://example.test/start");
  assert.equal(result.bytes, Buffer.byteLength(html));
  assert.equal(result.code, 200);
  assert.equal(result.codeText, "OK");
  assert.equal(result.durationMs, 15);
  assert.equal(result.result, "Clean extracted content");
  assert.equal(result.finalUrl, "https://example.test/final");
  assert.deepEqual(result.redirects, [{ url: "https://example.test/final", status: 301 }]);
  assert.equal(result.tier, 1);
  assert.equal(result.output, "raw");
  assert.deepEqual(result.platform, {
    adapterId: "generic",
    label: "Generic HTML",
    detectedFrom: "tier1",
  });
  assert.equal(result.jsRequired, false);
  assert.equal(result.resolvedVia, "tier1-meta");
  assert.deepEqual(result.attempts, [{
    step: 1,
    tier: 1,
    outcome: "ok",
    status: 200,
    durationMs: 12,
    bytes: Buffer.byteLength(html),
    reason: "content-present",
  }]);
  assert.equal(result.contentType, "text/html; charset=utf-8");
  assert.equal(result.title, "Extracted Title");
  assert.deepEqual(result.structured, { og: { "og:title": "Extracted Title" } });
  assert.deepEqual(result.timings, { totalMs: 15, fetchMs: 12 });
  assert.deepEqual(result.errors, []);
  assert.equal(result.fetchedAt, "2026-06-16T00:00:00.000Z");
});

test("guarded-fetch reject returns structured error and short-circuits extraction", async () => {
  const fetcher = new FakeFetcher({
    rejected: true,
    code: "private_address",
    message: "Resolved address is private",
  });
  const extractor = new FakeExtractor(extraction({ text: "must not run" }));

  const result = await createSmartFetchUseCase({
    fetcher,
    extractHtml: extractor.extract,
    clock: new FakeClock([0, 7]),
  }).execute({ url: "https://blocked.test/private" });

  assert.equal(extractor.calls.length, 0, "blocked fetch short-circuited extraction");
  assert.equal(result.tier, "error");
  assert.equal(result.code, 0);
  assert.equal(result.codeText, "FETCH_REJECTED");
  assert.equal(result.result, "Resolved address is private");
  assert.deepEqual(result.errors, [{
    code: "private_address",
    message: "Resolved address is private",
  }]);
  assert.deepEqual(result.attempts, [{
    step: 1,
    tier: 1,
    outcome: "block",
    durationMs: 7,
    reason: "private_address",
  }]);
});

test("invalid input is rejected before fetch, extraction, transform, or render", async () => {
  const fetcher = new FakeFetcher(fetchResult({ html: "unused" }));
  const extractor = new FakeExtractor(extraction({ text: "unused" }));
  const transformer = new FakeTransform();
  const renderer = new FakeRenderer();

  await assert.rejects(
    createSmartFetchUseCase({
      fetcher,
      extractHtml: extractor.extract,
      transformer,
      renderer,
      clock: new FakeClock([0]),
    }).execute({ url: "file:///etc/passwd" }),
    (error) => {
      assert.equal(error instanceof SmartFetchInputError, true);
      assert.deepEqual((error as SmartFetchInputError).body, {
        error: { code: "unsupported_scheme", message: "Only http and https URLs are allowed" },
      });
      return true;
    },
  );

  assert.equal(fetcher.calls.length, 0);
  assert.equal(extractor.calls.length, 0);
  assert.equal(transformer.calls.length, 0);
  assert.equal(renderer.calls.length, 0);
});

test("output raw returns clean content without transform", async () => {
  const transformer = new FakeTransform();
  const result = await createSmartFetchUseCase({
    fetcher: new FakeFetcher(fetchResult({ html: "<main>Raw</main>" })),
    extractHtml: new FakeExtractor(extraction({ text: "Clean raw content" })).extract,
    transformer,
    clock: new FakeClock([0, 3, 4, 4]),
  }).execute({ url: "https://raw.test/", output: "raw" });

  assert.equal(result.output, "raw");
  assert.equal(result.result, "Clean raw content");
  assert.equal(result.transform, undefined);
  assert.equal(transformer.calls.length, 0);
});

test("default summary degrades to raw with unconfigured transform provenance", async () => {
  const result = await createSmartFetchUseCase({
    fetcher: new FakeFetcher(fetchResult({ html: "<main>Summary</main>" })),
    extractHtml: new FakeExtractor(extraction({ text: "Raw fallback content" })).extract,
    clock: new FakeClock([10, 14, 15, 15]),
  }).execute({ url: "https://summary.test/" });

  assert.equal(result.output, "raw");
  assert.equal(result.result, "Raw fallback content");
  assert.deepEqual(result.transform, { provider: "none", reason: "unconfigured" });
  assert.equal(result.timings.transformMs, 0);
});

test("allowRender defaults false and render port is not called on shell gate", async () => {
  const renderer = new FakeRenderer();
  const result = await createSmartFetchUseCase({
    fetcher: new FakeFetcher(fetchResult({ html: "<div id=\"root\"></div>" })),
    extractHtml: new FakeExtractor(extraction({
      text: "",
      jsRequired: true,
      shellReason: "empty-spa-shell",
    })).extract,
    renderer,
    clock: new FakeClock([0, 5, 6, 6]),
  }).execute({ url: "https://spa.test/", output: "raw" });

  assert.equal(renderer.calls.length, 0);
  assert.equal(result.tier, "render-blocked");
  assert.equal(result.jsRequired, true);
  assert.equal(result.resolvedVia, "render-blocked");
  assert.deepEqual(result.attempts.map((attempt) => [attempt.tier, attempt.outcome, attempt.reason]), [
    [1, "escalate", "empty-spa-shell"],
    ["render-blocked", "block", "allowRender=false"],
  ]);
});

test("allowRender true renders shell and returns Tier-3 provenance", async () => {
  const shellHtml = "<div id=\"root\"></div><script src=\"/app.js\"></script>";
  const renderedHtml = "<main>Rendered content from the client app</main>";
  const renderer = new FakeRenderer({
    rendered: true,
    fetchResult: fetchResult({
      html: renderedHtml,
      finalUrl: "https://spa.test/app",
    }),
    actions: [{
      type: "websocket-closed",
      reason: "websockets disabled",
      url: "wss://spa.test/socket",
    }],
  });
  const extractor = new ScriptedExtractor((input) => {
    if (input.html === renderedHtml) {
      return extraction({ text: "Rendered content from the client app" });
    }
    return extraction({ text: "", jsRequired: true, shellReason: "empty-spa-shell" });
  });

  const result = await createSmartFetchUseCase({
    fetcher: new FakeFetcher(fetchResult({
      html: shellHtml,
      finalUrl: "https://spa.test/",
    })),
    extractHtml: extractor.extract,
    renderer,
    clock: new FakeClock([0, 5, 6, 7, 19, 20, 21]),
  }).execute({ url: "https://spa.test/", output: "raw", allowRender: true });

  assert.equal(renderer.calls.length, 1);
  assert.equal(renderer.calls[0]?.url, "https://spa.test/");
  assert.equal(renderer.calls[0]?.timeoutMs, 20_000);
  assert.equal(result.tier, 3);
  assert.equal(result.resolvedVia, "tier3-playwright");
  assert.equal(result.result, "Rendered content from the client app");
  assert.equal(result.timings.renderMs, 12);
  assert.deepEqual(result.attempts.map((attempt) => [attempt.tier, attempt.outcome, attempt.reason]), [
    [1, "escalate", "empty-spa-shell"],
    [3, "ok", "rendered"],
    [3, "block", "websocket-closed:websockets disabled:wss://spa.test/socket"],
  ]);
});

test("configured transform receives prompt, schema, budget, and transform override", async () => {
  const transformer = new FakeTransform({
    result: "Transformed summary",
    info: { provider: "openrouter", model: "free/model", free: true },
  });
  const schema = { type: "object", properties: { title: { type: "string" } } };
  const override = { provider: "ollama", model: "llama-local", temperature: 0 };

  const result = await createSmartFetchUseCase({
    fetcher: new FakeFetcher(fetchResult({ html: "<main>Transform</main>" })),
    extractHtml: new FakeExtractor(extraction({ text: "Source content" })).extract,
    transformer,
    clock: new FakeClock([20, 25, 27, 27, 30, 30]),
  }).execute({
    url: "https://transform.test/",
    output: "summary",
    prompt: "Summarize this",
    schema,
    budget: 200,
    transform: override,
  });

  assert.equal(result.output, "summary");
  assert.equal(result.result, "Transformed summary");
  const call = transformer.calls[0];
  assert.equal(call.mode, "summarize");
  assert.equal(call.output, "summary");
  assert.equal(call.prompt, "Summarize this");
  assert.equal(call.sourceUrl, "https://example.test/");
  assert.equal(call.schema, schema);
  assert.equal(call.budget, 200);
  assert.deepEqual(call.transform, override);
  // content is transformContent(): the body plus the page-metadata envelope hint.
  assert.ok(call.content.endsWith("Source content"), `body present in content: ${call.content}`);
  assert.match(call.content, /Page metadata:/);
  assert.deepEqual(result.transform, { provider: "openrouter", model: "free/model", free: true });
  assert.equal(result.timings.transformMs, 3);
});

class FakeClock implements ClockPort {
  private index = 0;
  private readonly ticks: number[];

  constructor(ticks: number[]) {
    this.ticks = ticks;
  }

  nowMs(): number {
    const tick = this.ticks[Math.min(this.index, this.ticks.length - 1)];
    this.index += 1;
    return tick ?? 0;
  }
}

class FakeFetcher implements FetcherPort {
  readonly calls: Array<{ url: string; opts: FetcherOptions }> = [];
  private readonly result: FetcherResult | RejectResult;

  constructor(result: FetcherResult | RejectResult) {
    this.result = result;
  }

  async fetchGuarded(url: string, opts: FetcherOptions): Promise<FetcherResult | RejectResult> {
    this.calls.push({ url, opts });
    return this.result;
  }
}

class FakeExtractor {
  readonly calls: HtmlExtractionInput[] = [];
  private readonly result: HtmlExtraction;

  constructor(result: HtmlExtraction) {
    this.result = result;
  }

  extract = (input: HtmlExtractionInput): HtmlExtraction => {
    this.calls.push(input);
    return this.result;
  };
}

class ScriptedExtractor {
  readonly calls: HtmlExtractionInput[] = [];
  private readonly handler: (input: HtmlExtractionInput) => HtmlExtraction;

  constructor(handler: (input: HtmlExtractionInput) => HtmlExtraction) {
    this.handler = handler;
  }

  extract = (input: HtmlExtractionInput): HtmlExtraction => {
    this.calls.push(input);
    return this.handler(input);
  };
}

class FakeTransform implements TransformPort {
  readonly calls: TransformInput[] = [];
  private readonly result: TransformResult;

  constructor(result: TransformResult = {
    result: "transformed",
    info: { provider: "openrouter", model: "test", free: true },
  }) {
    this.result = result;
  }

  async transform(input: TransformInput): Promise<TransformResult> {
    this.calls.push(input);
    return this.result;
  }
}

class FakeRenderer implements RenderPort {
  readonly calls: RenderInput[] = [];
  private readonly output: RenderOutput;

  constructor(output: RenderOutput = {
    rendered: true,
    fetchResult: fetchResult({ html: "<main>rendered</main>" }),
    actions: [],
  }) {
    this.output = output;
  }

  async render(input: RenderInput): Promise<RenderOutput> {
    this.calls.push(input);
    return this.output;
  }
}

function extraction(input: {
  title?: string;
  text?: string;
  structured?: HtmlExtraction["structured"];
  jsRequired?: boolean;
  shellReason?: HtmlExtraction["shellGate"]["reason"];
}): HtmlExtraction {
  return {
    title: input.title,
    text: input.text ?? "",
    structured: input.structured ?? {},
    shellGate: {
      jsRequired: input.jsRequired ?? false,
      reason: input.shellReason ?? "content-present",
      textLength: input.text?.length ?? 0,
      wordCount: input.text ? input.text.split(/\s+/).length : 0,
      scriptCount: input.jsRequired ? 2 : 0,
      appRootFound: input.jsRequired ?? false,
      structuredDataFound: Object.keys(input.structured ?? {}).length > 0,
    },
    errors: [],
  };
}

function fetchResult(input: {
  html: string;
  finalUrl?: string;
  redirects?: FetcherResult["redirects"];
}): FetcherResult {
  const bytes = new TextEncoder().encode(input.html);
  return {
    status: 200,
    finalUrl: input.finalUrl ?? "https://example.test/",
    redirects: input.redirects ?? [],
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

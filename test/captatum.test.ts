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
import { createCaptatumUseCase } from "../src/application/use-cases/captatum.ts";
import type { HtmlExtraction, HtmlExtractionInput } from "../src/application/use-cases/tier1-extract.ts";
import { CaptatumInputError } from "../src/application/use-cases/captatum-input.ts";

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

  const result = await createCaptatumUseCase({
    fetcher,
    extractHtml: extractor.extract,
    clock: new FakeClock([100, 100, 112, 115, 115]),
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

  const result = await createCaptatumUseCase({
    fetcher,
    extractHtml: extractor.extract,
    clock: new FakeClock([0, 0, 7]),
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
    createCaptatumUseCase({
      fetcher,
      extractHtml: extractor.extract,
      transformer,
      renderer,
      clock: new FakeClock([0, 0]),
    }).execute({ url: "file:///etc/passwd" }),
    (error) => {
      assert.equal(error instanceof CaptatumInputError, true);
      assert.deepEqual((error as CaptatumInputError).body, {
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

test("output:extract rejects an unsupported schema keyword at the input boundary before fetch (#153)", async () => {
  // Exact repro from #153: a schema carrying `$schema` (supported) AND `budget` (unsupported).
  // The error must name `budget` — leading with the key — not visually merge `$` + `schema`
  // into `$schema` as the old "$ schema keyword \"budget\" is not supported" message did.
  const fetcher = new FakeFetcher(fetchResult({ html: "<main>unused</main>" }));
  const extractor = new FakeExtractor(extraction({ text: "unused" }));
  const transformer = new FakeTransform();
  const renderer = new FakeRenderer();

  await assert.rejects(
    createCaptatumUseCase({
      fetcher,
      extractHtml: extractor.extract,
      transformer,
      renderer,
      clock: new FakeClock([0, 0]),
    }).execute({
      url: "https://extract.test/repro",
      output: "extract",
      schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { a: { type: "string" } }, budget: 8000 },
    }),
    (error) => {
      assert.equal(error instanceof CaptatumInputError, true);
      const body = (error as CaptatumInputError).body.error;
      assert.equal(body.code, "invalid_schema");
      assert.equal(body.message, 'Unsupported JSON Schema keyword "budget" at $ — captatum cannot verify it; remove it.');
      assert.doesNotMatch(body.message, /\$schema/, "message must not visually merge `$` + `schema` into `$schema`");
      return true;
    },
  );
  // Fail-fast: a schema captatum cannot verify does no outbound work.
  assert.equal(fetcher.calls.length, 0);
  assert.equal(extractor.calls.length, 0);
  assert.equal(transformer.calls.length, 0);
  assert.equal(renderer.calls.length, 0);
});

test("output:extract rejects a malformed (non-object) schema at the input boundary (#153)", async () => {
  const transformer = new FakeTransform();
  await assert.rejects(
    createCaptatumUseCase({
      fetcher: new FakeFetcher(fetchResult({ html: "<main>unused</main>" })),
      extractHtml: new FakeExtractor(extraction({ text: "unused" })).extract,
      transformer,
      clock: new FakeClock([0, 0]),
    }).execute({ url: "https://extract.test/malformed", output: "extract", schema: 42 }),
    (error) => {
      assert.equal(error instanceof CaptatumInputError, true);
      const body = (error as CaptatumInputError).body.error;
      assert.equal(body.code, "invalid_schema");
      assert.match(body.message, /must be a JSON Schema object or boolean \(received number at \$\)/);
      return true;
    },
  );
  assert.equal(transformer.calls.length, 0);
});

test("output:extract rejects a pathologically DEEP schema at the input boundary — no fetch, no LLM, no finalize stack overflow (#153 P1)", async () => {
  // A deep all-SUPPORTED-keyword schema passes the node cap but would stack-overflow the recursive
  // value validator after a billed LLM call. The depth cap rejects it fail-fast at the boundary.
  let deep: Record<string, unknown> = { type: "object" };
  for (let i = 0; i < 500; i += 1) deep = { allOf: [deep] };
  const fetcher = new FakeFetcher(fetchResult({ html: "<main>unused</main>" }));
  const transformer = new FakeTransform();
  await assert.rejects(
    createCaptatumUseCase({
      fetcher,
      extractHtml: new FakeExtractor(extraction({ text: "unused" })).extract,
      transformer,
      clock: new FakeClock([0, 0]),
    }).execute({ url: "https://extract.test/deep", output: "extract", schema: deep }),
    (error) => {
      assert.equal(error instanceof CaptatumInputError, true);
      assert.equal((error as CaptatumInputError).body.error.code, "invalid_schema");
      return true;
    },
  );
  assert.equal(fetcher.calls.length, 0);
  assert.equal(transformer.calls.length, 0);
});

test("output:extract rejects a tuple (array-valued) items schema at the input boundary (#153)", async () => {
  // `items` is a supported key, but a tuple value can't be positionally validated — reject
  // fail-fast instead of accepting then advisory-after-LLM (scan and value-validator agree).
  const transformer = new FakeTransform();
  await assert.rejects(
    createCaptatumUseCase({
      fetcher: new FakeFetcher(fetchResult({ html: "<main>unused</main>" })),
      extractHtml: new FakeExtractor(extraction({ text: "unused" })).extract,
      transformer,
      clock: new FakeClock([0, 0]),
    }).execute({ url: "https://extract.test/tuple", output: "extract", schema: { type: "array", items: [{ type: "string" }, { type: "number" }] } }),
    (error) => {
      assert.equal(error instanceof CaptatumInputError, true);
      assert.equal((error as CaptatumInputError).body.error.code, "invalid_schema");
      assert.match((error as CaptatumInputError).body.error.message, /"items".*tuple\/array/);
      return true;
    },
  );
  assert.equal(transformer.calls.length, 0);
});

test("output:extract rejects a scalar (non-boolean/non-object) items schema at the input boundary (#153 codex P2)", async () => {
  // {type:"array", items:42} is neither a tuple nor a valid schema — it must fail closed at the
  // boundary (codex: previously slipped through, fetched+LLM'd, and was accepted for an empty array).
  const transformer = new FakeTransform();
  await assert.rejects(
    createCaptatumUseCase({
      fetcher: new FakeFetcher(fetchResult({ html: "<main>unused</main>" })),
      extractHtml: new FakeExtractor(extraction({ text: "unused" })).extract,
      transformer,
      clock: new FakeClock([0, 0]),
    }).execute({ url: "https://extract.test/scalar-items", output: "extract", schema: { type: "array", items: 42 } }),
    (error) => {
      assert.equal(error instanceof CaptatumInputError, true);
      assert.equal((error as CaptatumInputError).body.error.code, "invalid_schema");
      return true;
    },
  );
  assert.equal(transformer.calls.length, 0);
});

test("output:extract rejects an oversized schema (huge terminal value) at the input boundary, before fetch (#153 codex P2)", async () => {
  // One node, depth 1, all-supported keywords — passes the node/depth caps — but a multi-MB
  // `description` would be JSON.stringify'd into the transform prompt. The byte cap rejects it
  // fail-fast before any fetch/LLM.
  const fetcher = new FakeFetcher(fetchResult({ html: "<main>unused</main>" }));
  const transformer = new FakeTransform();
  await assert.rejects(
    createCaptatumUseCase({
      fetcher,
      extractHtml: new FakeExtractor(extraction({ text: "unused" })).extract,
      transformer,
      clock: new FakeClock([0, 0]),
    }).execute({ url: "https://extract.test/huge", output: "extract", schema: { type: "object", description: "x".repeat(70 * 1024) } }),
    (error) => {
      assert.equal(error instanceof CaptatumInputError, true);
      assert.equal((error as CaptatumInputError).body.error.code, "invalid_schema");
      return true;
    },
  );
  assert.equal(fetcher.calls.length, 0);
  assert.equal(transformer.calls.length, 0);
});

test("a valid extract schema passes the input boundary and reaches the transform (#153)", async () => {
  const transformer = new FakeTransform({ result: '{"title":"x"}', info: { provider: "openrouter", model: "test", free: true } });
  const result = await createCaptatumUseCase({
    fetcher: new FakeFetcher(fetchResult({ html: "<main>extract</main>" })),
    extractHtml: new FakeExtractor(extraction({ text: "page" })).extract,
    transformer,
    clock: new FakeClock([0, 0, 3, 4, 4]),
  }).execute({ url: "https://extract.test/ok", output: "extract", schema: { type: "object", properties: { title: { type: "string" } } } });

  assert.equal(result.output, "extract");
  assert.equal(result.outputRequested, "extract");
  assert.equal(transformer.calls.length, 1);
  assert.equal(result.result, '{"title":"x"}');
});

test("output raw returns clean content without transform", async () => {
  const transformer = new FakeTransform();
  const result = await createCaptatumUseCase({
    fetcher: new FakeFetcher(fetchResult({ html: "<main>Raw</main>" })),
    extractHtml: new FakeExtractor(extraction({ text: "Clean raw content" })).extract,
    transformer,
    clock: new FakeClock([0, 0, 3, 4, 4]),
  }).execute({ url: "https://raw.test/", output: "raw" });

  assert.equal(result.output, "raw");
  assert.equal(result.result, "Clean raw content");
  assert.equal(result.transform, undefined);
  assert.equal(transformer.calls.length, 0);
});

test("default output is raw when no transform provider is configured (no silent excerpt)", async () => {
  // raw-default: with no provider the default is raw — full content, no transform,
  // no silent truncated excerpt. (Requesting summary explicitly still falls back.)
  const result = await createCaptatumUseCase({
    fetcher: new FakeFetcher(fetchResult({ html: "<main>Summary</main>" })),
    extractHtml: new FakeExtractor(extraction({ text: "Raw fallback content" })).extract,
    clock: new FakeClock([10, 10, 14, 15, 15]),
  }).execute({ url: "https://summary.test/" });

  assert.equal(result.output, "raw");
  assert.equal(result.result, "Raw fallback content");
  assert.equal(result.transform, undefined);
});

test("a transformer that omits hasProvider is treated as configured (summary default)", async () => {
  // Regression guard (codex P2): a custom TransformPort that implements transform but
  // not hasProvider still provides summaries — the default is summary, not raw.
  const transformer = {
    async transform() {
      return { result: "custom summary", info: { provider: "custom", model: "x", free: false, inTokens: 1, outTokens: 1, latencyMs: 1, costUsd: 0 } };
    },
  };
  const result = await createCaptatumUseCase({
    fetcher: new FakeFetcher(fetchResult({ html: "<main>body</main>" })),
    extractHtml: new FakeExtractor(extraction({ text: "page body" })).extract,
    transformer: transformer as never,
    clock: new FakeClock([0, 0, 1, 2, 2]),
  }).execute({ url: "https://custom.test/" });

  assert.equal(result.output, "summary");
  assert.equal(result.result, "custom summary");
});

test("summary requested with no transformer degrades to raw with unconfigured provenance", async () => {
  const result = await createCaptatumUseCase({
    fetcher: new FakeFetcher(fetchResult({ html: "<main>Summary</main>" })),
    extractHtml: new FakeExtractor(extraction({ text: "Raw fallback content" })).extract,
    clock: new FakeClock([10, 10, 14, 15, 15]),
  }).execute({ url: "https://summary.test/", output: "summary" });

  assert.equal(result.output, "raw");
  assert.equal(result.result, "Raw fallback content");
  assert.deepEqual(result.transform, { provider: "none", reason: "unconfigured" });
  assert.equal(result.timings.transformMs, 0);
});

test("allowRender defaults true (a shell gate triggers a render); explicit false opts out → render-blocked", async () => {
  const renderer = new FakeRenderer();
  const result = await createCaptatumUseCase({
    fetcher: new FakeFetcher(fetchResult({ html: "<div id=\"root\"></div>" })),
    extractHtml: new FakeExtractor(extraction({
      text: "",
      jsRequired: true,
      shellReason: "empty-spa-shell",
    })).extract,
    renderer,
    clock: new FakeClock([0, 0, 5, 6, 6]),
  }).execute({ url: "https://spa.test/", output: "raw", allowRender: false });

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

  const result = await createCaptatumUseCase({
    fetcher: new FakeFetcher(fetchResult({
      html: shellHtml,
      finalUrl: "https://spa.test/",
    })),
    extractHtml: extractor.extract,
    renderer,
    clock: new FakeClock([0, 0, 5, 6, 7, 19, 20, 21]),
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

test("a render that still yields an empty shell is NOT promoted to Tier-3 (#110)", async () => {
  // The renderer ran, but the rendered HTML is STILL an empty shell (jsRequired) — the client
  // app didn't load content (blocked bundle, failed data fetch). Don't promote it as a Tier-3
  // pass with empty text; reject honestly with a render_empty error.
  const shellHtml = "<div id=\"root\"></div>";
  const renderedHtml = "<div id=\"root\"></div>"; // rendered, but still empty
  const renderer = new FakeRenderer({ rendered: true, fetchResult: fetchResult({ html: renderedHtml }), actions: [] });
  const extractor = new ScriptedExtractor((_input) => extraction({ text: "", jsRequired: true, shellReason: "empty-spa-shell" }));

  const result = await createCaptatumUseCase({
    fetcher: new FakeFetcher(fetchResult({ html: shellHtml })),
    extractHtml: extractor.extract,
    renderer,
    clock: new FakeClock([0, 0, 5, 6, 7]),
  }).execute({ url: "https://spa.test/", output: "raw", allowRender: true });

  assert.equal(renderer.calls.length, 1, "render was attempted");
  assert.notEqual(result.tier, 3, "empty render must NOT be promoted to Tier-3");
  assert.equal(result.tier, "error");
  assert.equal(result.resolvedVia, "tier3-playwright");
  assert.ok(result.errors.some((e) => e.code === "render_empty"), "render_empty error recorded");
});

test("a render with usable structured data but no visible text is promoted, not render_empty (#110 codex P2)", async () => {
  // The rendered page has no body text, but the client app injected a JobPosting JSON-LD. The
  // shell-gate sets jsRequired=false (structured-data-found), so this is NOT an empty render —
  // promote it so summary/extract can consume the structured data.
  const shellHtml = "<div id=\"root\"></div>";
  const renderedHtml = "<div id=\"root\"></div><script type=\"application/ld+json\">{\"@type\":\"JobPosting\"}</script>";
  const renderer = new FakeRenderer({ rendered: true, fetchResult: fetchResult({ html: renderedHtml }), actions: [] });
  const extractor = new ScriptedExtractor((input) => {
    if (input.html === renderedHtml) {
      return extraction({ text: "", jsRequired: false, shellReason: "structured-data-found", structured: { jsonLd: { "@type": "JobPosting", title: "Senior Engineer" } } });
    }
    return extraction({ text: "", jsRequired: true, shellReason: "empty-spa-shell" });
  });

  const result = await createCaptatumUseCase({
    fetcher: new FakeFetcher(fetchResult({ html: shellHtml })),
    extractHtml: extractor.extract,
    renderer,
    clock: new FakeClock([0, 0, 5, 6, 7, 19, 20, 21]),
  }).execute({ url: "https://spa.test/", output: "raw", allowRender: true });

  assert.equal(result.tier, 3, "structured-data render is promoted (not render_empty)");
  assert.equal(result.resolvedVia, "tier3-playwright");
  assert.equal(result.errors.some((e) => e.code === "render_empty"), false, "no render_empty error");
  assert.deepEqual(result.structured?.jsonLd, { "@type": "JobPosting", title: "Senior Engineer" });
});

test("configured transform receives prompt, schema, budget, and transform override", async () => {
  const transformer = new FakeTransform({
    result: "Transformed summary",
    info: { provider: "openrouter", model: "free/model", free: true },
  });
  const schema = { type: "object", properties: { title: { type: "string" } } };
  const override = { provider: "ollama", model: "llama-local", temperature: 0 };

  const result = await createCaptatumUseCase({
    fetcher: new FakeFetcher(fetchResult({ html: "<main>Transform</main>" })),
    extractHtml: new FakeExtractor(extraction({ text: "Source content" })).extract,
    transformer,
    clock: new FakeClock([20, 20, 25, 27, 27, 30, 30]),
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

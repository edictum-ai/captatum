import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { FetcherOptions, FetcherPort, FetcherResult, RejectResult } from "../src/application/ports/fetcher.ts";
import type { ClockPort } from "../src/application/ports/clock.ts";
import { createSmartFetchUseCase } from "../src/application/use-cases/smart-fetch.ts";
import { extractHtml } from "../src/infrastructure/extract/index.ts";
import { resultToMcpText } from "../src/interfaces/mcp/format.ts";

const FIXTURE_DIR = join(process.cwd(), "test", "fixtures", "contracts");
const PAGE_DIR = join(FIXTURE_DIR, "pages");
const FIXTURES = ["raw-safe", "summary-fallback", "blocked-ssrf", "render-disabled"] as const;

for (const name of FIXTURES) {
  test(`contract fixture ${name} matches current smart_fetch output`, async () => {
    const fixture = loadFixture(name);
    const useCase = createSmartFetchUseCase({
      fetcher: new ContractFixtureFetcher(),
      extractHtml,
      clock: fixedClock(),
    });

    const result = await useCase.execute(fixture.input);

    assert.deepEqual(result, fixture.structuredContent);
    assert.equal(resultToMcpText(result), fixture.mcpText);
  });
}

test("contract fixture index covers the docs examples", () => {
  const names = FIXTURES.map((name) => loadFixture(name).name).sort();
  assert.deepEqual(names, ["blocked-ssrf", "raw-safe", "render-disabled", "summary-fallback"]);
});

class ContractFixtureFetcher implements FetcherPort {
  async fetchGuarded(url: string, _opts: FetcherOptions): Promise<FetcherResult | RejectResult> {
    if (url.includes("169.254.169.254")) {
      return {
        rejected: true,
        code: "private_address",
        message: "Host resolves to a private or reserved address",
      };
    }
    return fetchResult(url, pageFor(url));
  }
}

function pageFor(url: string): string {
  const name = url.includes("/spa") ? "spa-shell.html" : "content.html";
  return readFileSync(join(PAGE_DIR, name), "utf8");
}

function fetchResult(finalUrl: string, html: string): FetcherResult {
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

function fixedClock(): ClockPort {
  return { nowMs: () => 0 };
}

function loadFixture(name: string): ContractFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8")) as ContractFixture;
}

interface ContractFixture {
  name: string;
  input: Record<string, unknown>;
  structuredContent: Record<string, unknown>;
  mcpText: string;
}

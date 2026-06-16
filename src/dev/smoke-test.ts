import type { FetcherOptions, FetcherPort, FetcherResult } from "../application/ports/fetcher.ts";
import type { ClockPort } from "../application/ports/clock.ts";
import { createSmartFetchUseCase } from "../application/use-cases/smart-fetch.ts";
import { extractHtml } from "../infrastructure/extract/index.ts";

class SmokeClock implements ClockPort {
  private tick = 0;

  nowMs(): number {
    this.tick += 1;
    return this.tick;
  }
}

class SmokeFetcher implements FetcherPort {
  calls: Array<{ url: string; opts: FetcherOptions }> = [];

  async fetchGuarded(url: string, opts: FetcherOptions): Promise<FetcherResult> {
    this.calls.push({ url, opts });
    const html = "<main><h1>Smoke</h1><p>smart-fetch smoke fixture content.</p></main>";
    const bytes = new TextEncoder().encode(html);
    return {
      status: 200,
      finalUrl: url,
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
}

const fetcher = new SmokeFetcher();
const result = await createSmartFetchUseCase({
  fetcher,
  extractHtml,
  clock: new SmokeClock(),
}).execute({ url: "https://smoke.test/", output: "raw" });

if (fetcher.calls.length !== 1 || result.tier !== 1 || result.output !== "raw") {
  throw new Error("smart-fetch smoke failed");
}

console.log("smart-fetch smoke ok");

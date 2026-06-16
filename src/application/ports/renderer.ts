import type { FetcherPort, FetcherResult, RejectResult } from "./fetcher.ts";

export interface RenderInput {
  url: string;
  maxBytes: number;
  timeoutMs: number;
  fetcher: FetcherPort;
}

/**
 * Tier-3 render seam. Concrete Playwright code lives outside the core
 * application layer and is intentionally not implemented in P3.
 */
export interface RenderPort {
  render(input: RenderInput): Promise<FetcherResult | RejectResult>;
}

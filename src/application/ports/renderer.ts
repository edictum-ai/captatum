import type { FetcherPort, FetcherResult, RejectResult } from "./fetcher.ts";
import type { ProvenanceError } from "../../domain/result.ts";

export interface RenderInput {
  url: string;
  maxBytes: number;
  timeoutMs: number;
  maxHops: number;
  fetcher: FetcherPort;
}

export type RenderActionType =
  | "service-workers-disabled"
  | "resource-aborted"
  | "request-blocked"
  | "websocket-closed"
  | "download-blocked"
  | "request-forwarded-post";

export interface RenderAction {
  type: RenderActionType;
  /** Optional for forwarded actions (a forwarded POST has no abort reason); required for blocks. */
  reason?: string;
  url?: string;
  resourceType?: string;
  /** Outcome of the action — defaults to "block" for back-compat (#111 provenance for forwards). */
  outcome?: "ok" | "block";
  /** Provenance for a forwarded POST (request-forwarded-post): the page-authored egress. */
  method?: string;
  bodyBytes?: number;
  responseBytes?: number;
}

export interface RenderSuccess {
  rendered: true;
  fetchResult: FetcherResult;
  actions: RenderAction[];
  /**
   * Advisory provenance note for a successful-but-degraded render (e.g. the
   * rendered HTML exceeded the byte cap and was truncated rather than rejected).
   * Surfaced into Result.errors by the use case; non-fatal.
   */
  notice?: ProvenanceError;
}

export type RenderFailure = RejectResult & {
  rendered: false;
  actions: RenderAction[];
};

export type RenderOutput = RenderSuccess | RenderFailure;

/** Tier-3 render seam. Concrete browser code lives outside the application layer. */
export interface RenderPort {
  render(input: RenderInput): Promise<RenderOutput>;
}

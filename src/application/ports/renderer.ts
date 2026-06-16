import type { FetcherPort, FetcherResult, RejectResult } from "./fetcher.ts";

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
  | "download-blocked";

export interface RenderAction {
  type: RenderActionType;
  reason: string;
  url?: string;
  resourceType?: string;
}

export interface RenderSuccess {
  rendered: true;
  fetchResult: FetcherResult;
  actions: RenderAction[];
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

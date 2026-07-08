import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AuditLoggerPort } from "../../application/ports/audit.ts";
import type { ClockPort } from "../../application/ports/clock.ts";
import type { FetcherPort } from "../../application/ports/fetcher.ts";
import type { RenderPort } from "../../application/ports/renderer.ts";
import type { TransformPort } from "../../application/ports/transformer.ts";
import {
  loadAuthRuntimeConfig,
  type AuthRuntimeConfig,
} from "../../application/use-cases/oauth-config.ts";
import { createRequestAuthorizer } from "../../application/use-cases/request-auth.ts";
import { createCaptatumUseCase } from "../../application/use-cases/captatum.ts";
import { createCaptatumBulkUseCase } from "../../application/use-cases/captatum-bulk.ts";
import { createAdapterRegistry } from "../../application/adapters.ts";
import { config } from "../../config.ts";
import { BULK_GUARD_CEILINGS } from "../../domain/bulk-policy.ts";
import type { HtmlExtractor } from "../../application/use-cases/tier1-extract.ts";
import { createCaptatumMcpServer } from "./server.ts";

/**
 * Thrown when the local stdio bridge is asked to run under a non-local flavor.
 * The local binary has no auth boundary, so it must never be wired to the hosted
 * (network-listener) path — that would expose an unauthenticated surface.
 */
export class LocalFlavorError extends Error {
  readonly code = "local_flavor_required";
}

export interface LocalMcpDeps {
  fetcher: FetcherPort;
  extractHtml: HtmlExtractor;
  clock: ClockPort;
  audit: AuditLoggerPort;
  transformer?: TransformPort;
  renderer?: RenderPort;
  /** Defaults to the process-resolved runtime config; must be local-binary. */
  runtime?: AuthRuntimeConfig;
}

/**
 * Fail loudly if local mode is pointed at the hosted flavor. The stdio bridge is
 * single-user/single-agent and opens no network listener; the hosted flavor owns
 * OAuth + the HTTP listener and is reached only through `src/server.ts`.
 */
export function assertLocalFlavor(runtime: AuthRuntimeConfig): void {
  if (runtime.flavor !== "local-binary") {
    throw new LocalFlavorError(
      "Local stdio bridge runs only under the local-binary flavor; " +
        "refusing to start a hosted/network-listener path with no OAuth boundary.",
    );
  }
}

/**
 * Build the same MCP server the hosted `POST /mcp` route serves, but for the
 * self-contained local-binary flavor: identical `captatum` tool (same schema,
 * same core use case, same guarded fetch), single-user local auth, no OAuth
 * secrets, and no network transport. The caller attaches a stdio transport.
 */
export async function createLocalMcpServer(deps: LocalMcpDeps): Promise<Server> {
  const runtime = deps.runtime ?? loadAuthRuntimeConfig();
  assertLocalFlavor(runtime);
  const authorizer = createRequestAuthorizer({
    runtime,
    clock: deps.clock,
    audit: deps.audit,
  });
  const auth = await authorizer.authorize({});
  const captatum = createCaptatumUseCase({
    fetcher: deps.fetcher,
    extractHtml: deps.extractHtml,
    transformer: deps.transformer,
    renderer: deps.renderer,
    clock: deps.clock,
  });
  // Local flavor ships captatum_bulk ON (single-user; no admission cap, no BulkQuotaPort).
  // Built with the UNWRAPPED captatum executor (per-seed fan-out is bounded by the BulkGuard).
  const bulk = createCaptatumBulkUseCase({
    executor: captatum,
    adapters: createAdapterRegistry(),
    clock: deps.clock,
    operator: {
      maxPerHostInflight: config.bulk.maxPerHostInflight(),
      crawlDelayMs: config.bulk.crawlDelayMs(),
      maxConcurrency: config.bulk.maxConcurrency(),
      // The local-binary flavor has no client-side tool-call timeout (a patient stdio
      // client), so it is NOT subject to the #148 hosted orphaning rationale. Keep the
      // pre-#148 wall at the hard ceiling (180 s) so a local 50-URL / render-heavy bulk is
      // not narrowed to a premature 55 s `bulk_deadline_exceeded` partial (codex #156 P2).
      maxGlobalWallMs: BULK_GUARD_CEILINGS.maxGlobalWallMs,
    },
  });
  return createCaptatumMcpServer({
    captatum,
    bulk,
    auth,
    audit: deps.audit,
    clock: deps.clock,
  });
}

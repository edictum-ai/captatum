import Fastify, { type FastifyInstance } from "fastify";
import type { AuditLoggerPort } from "../../application/ports/audit.ts";
import type { ClockPort } from "../../application/ports/clock.ts";
import type { StorePort } from "../../application/ports/store.ts";
import type { AuthRuntimeConfig } from "../../application/use-cases/oauth-config.ts";
import { createRequestAuthorizer } from "../../application/use-cases/request-auth.ts";
import type { CaptatumUseCase } from "../../application/use-cases/captatum.ts";
import { config } from "../../config.ts";
import { BULK_GUARD_DEFAULTS } from "../../domain/bulk-policy.ts";
import { createCloudflareAccessJwtVerifier } from "../../infrastructure/auth/cloudflare-access-jwt.ts";
import { registerOAuthRoutes } from "./oauth-routes.ts";
import { registerMcpRoute } from "./mcp-route.ts";
import { sendHttpError } from "./errors.ts";
import type { CaptatumBulkMcpExecutor } from "../mcp/server.ts";

export interface HttpAppDeps {
  captatum: Pick<CaptatumUseCase, "execute" | "defaultOutput">;
  runtime: AuthRuntimeConfig;
  clock: ClockPort;
  audit: AuditLoggerPort;
  store?: StorePort;
  allowedHosts: string[];
  allowedOrigins: string[];
  /** Raw captatum_bulk use case; absent when CAPTATUM_BULK_ENABLED is off (hosted). */
  bulk?: CaptatumBulkMcpExecutor;
}

/**
 * Thrown when the HTTP MCP listener is asked to run under a non-hosted flavor.
 * The HTTP `/mcp` surface is the *hosted* (OAuth-authenticated) path; the
 * local-binary flavor has no auth boundary and must never be network-exposed.
 */
export class HostedFlavorError extends Error {
  readonly code = "hosted_flavor_required";
}

/**
 * Fail loudly *before* any network listener is built if the HTTP/OAuth surface is
 * pointed at the local-binary flavor. The HTTP `/mcp` listener authenticates
 * every call via OAuth; the local-binary flavor is single-user with no auth, so
 * serving it over a network listener would expose an unauthenticated `/mcp`.
 * Local mode runs over the stdio bridge
 * (`node --no-warnings src/interfaces/mcp/stdio-bridge.ts`) instead — never HTTP.
 */
export function assertHostedFlavor(runtime: AuthRuntimeConfig): void {
  if (runtime.flavor !== "hosted") {
    throw new HostedFlavorError(
      "HTTP MCP listener runs only under the hosted flavor; refusing to expose " +
        "the local-binary flavor (no OAuth boundary) on a network listener. " +
        "Run local mode over stdio with `node --no-warnings src/interfaces/mcp/stdio-bridge.ts`.",
    );
  }
}

/** HTTP request-timeout margin over the bulk wall (assembly + audit + network), so the
 *  HTTP backstop can never sever the structured partial the wall assembles. */
export const BULK_REQUEST_TIMEOUT_MARGIN_MS = 5_000;
/** Non-bulk (single-fetch) whole-request wall — defense-in-depth beyond the per-tier `timeoutMs`. */
export const NON_BULK_REQUEST_TIMEOUT_MS = 90_000;

/**
 * Resolve the Fastify `requestTimeout` from whether bulk is enabled. For bulk it tracks the
 * bulk wall + margin (so the two can NEVER drift and the HTTP backstop never cuts off a
 * wall-generated partial before it is returned); for single-fetch it is a fixed
 * defense-in-depth wall beyond the per-tier `timeoutMs` cap. Pure + exported so the
 * coupling + margin invariant can be teeth-checked (#148).
 */
export function resolveRequestTimeout(bulkEnabled: boolean): number {
  return bulkEnabled
    ? BULK_GUARD_DEFAULTS.maxGlobalWallMs + BULK_REQUEST_TIMEOUT_MARGIN_MS
    : NON_BULK_REQUEST_TIMEOUT_MS;
}

export async function createHttpApp(deps: HttpAppDeps): Promise<FastifyInstance> {
  assertHostedFlavor(deps.runtime);
  // requestTimeout bounds the whole request — defense-in-depth beyond the per-tier timeoutMs cap
  // (60s) so a hijacked/slow stream can't pin a connection. For bulk it tracks the bulk wall + a
  // 5s margin (resolveRequestTimeout) so the wall's structured partial is never cut off by the HTTP
  // backstop; the two are coupled so they cannot drift (#148).
  const requestTimeout = resolveRequestTimeout(deps.bulk !== undefined);
  const app = Fastify({ logger: false, bodyLimit: config.http.bodyLimitBytes, requestTimeout });
  app.setErrorHandler((error, _request, reply) => sendHttpError(reply, error));
  app.get("/healthz", async () => ({ status: "ok" }));

  if (deps.runtime.flavor === "hosted") {
    if (!deps.store) throw new Error("Hosted HTTP app requires a StorePort");
    // Build the Cloudflare Access verifier in the composition root and inject it
    // (the boot gate in oauth-config guarantees CF_ACCESS_* are set for hosted).
    const cf = config.cloudflareAccess;
    const cfAccessVerifier = cf.enabled() && cf.certsUrl()
      ? createCloudflareAccessJwtVerifier({
        audience: cf.audience(),
        certsUrl: cf.certsUrl(),
        issuer: cf.issuer(),
        emailAllowlist: cf.emailAllowlist(),
      })
      : undefined;
    await registerOAuthRoutes(app, {
      config: deps.runtime.oauth,
      store: deps.store,
      clock: deps.clock,
      audit: deps.audit,
      allowedOrigins: deps.allowedOrigins,
      cfAccessVerifier,
    });
  }

  await registerMcpRoute(app, {
    captatum: deps.captatum,
    authorizer: createRequestAuthorizer({ runtime: deps.runtime, clock: deps.clock, audit: deps.audit }),
    audit: deps.audit,
    clock: deps.clock,
    hosted: deps.runtime.flavor === "hosted",
    allowedHosts: deps.allowedHosts,
    allowedOrigins: deps.allowedOrigins,
    ...(deps.bulk !== undefined ? { bulk: deps.bulk } : {}),
  });
  return app;
}

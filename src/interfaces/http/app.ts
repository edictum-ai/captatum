import Fastify, { type FastifyInstance } from "fastify";
import type { AuditLoggerPort } from "../../application/ports/audit.ts";
import type { ClockPort } from "../../application/ports/clock.ts";
import type { StorePort } from "../../application/ports/store.ts";
import type { AuthRuntimeConfig } from "../../application/use-cases/oauth-config.ts";
import { createRequestAuthorizer } from "../../application/use-cases/request-auth.ts";
import type { SmartFetchUseCase } from "../../application/use-cases/smart-fetch.ts";
import { config } from "../../config.ts";
import { registerOAuthRoutes } from "./oauth-routes.ts";
import { registerMcpRoute } from "./mcp-route.ts";
import { sendHttpError } from "./errors.ts";

export interface HttpAppDeps {
  smartFetch: Pick<SmartFetchUseCase, "execute">;
  runtime: AuthRuntimeConfig;
  clock: ClockPort;
  audit: AuditLoggerPort;
  store?: StorePort;
  allowedHosts: string[];
  allowedOrigins: string[];
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

export async function createHttpApp(deps: HttpAppDeps): Promise<FastifyInstance> {
  assertHostedFlavor(deps.runtime);
  // requestTimeout (90s) bounds the whole request — defense-in-depth beyond the
  // per-tier timeoutMs cap (60s) so a hijacked/slow stream can't pin a connection.
  const app = Fastify({ logger: false, bodyLimit: config.http.bodyLimitBytes, requestTimeout: 90_000 });
  app.setErrorHandler((error, _request, reply) => sendHttpError(reply, error));
  app.get("/healthz", async () => ({ status: "ok" }));

  if (deps.runtime.flavor === "hosted") {
    if (!deps.store) throw new Error("Hosted HTTP app requires a StorePort");
    await registerOAuthRoutes(app, {
      config: deps.runtime.oauth,
      store: deps.store,
      clock: deps.clock,
      audit: deps.audit,
    });
  }

  await registerMcpRoute(app, {
    smartFetch: deps.smartFetch,
    authorizer: createRequestAuthorizer({ runtime: deps.runtime, clock: deps.clock, audit: deps.audit }),
    audit: deps.audit,
    clock: deps.clock,
    hosted: deps.runtime.flavor === "hosted",
    allowedHosts: deps.allowedHosts,
    allowedOrigins: deps.allowedOrigins,
  });
  return app;
}

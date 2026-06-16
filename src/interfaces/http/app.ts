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

export async function createHttpApp(deps: HttpAppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: config.http.bodyLimitBytes });
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

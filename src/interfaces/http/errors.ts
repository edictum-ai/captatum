import type { FastifyReply } from "fastify";
import { OAuthError, buildUnauthorizedChallenge, type BridgeConfig } from "mcp-sso";
import { AUTH_JSONRPC_CODE } from "../jsonrpc-error-codes.ts";

/** General Fastify error handler (non-OAuth-route errors; the mcp-sso `Bridge` catches
 *  its own OAuth-route errors and never throws here). An `OAuthError` reaching this is
 *  unexpected defense-in-depth — it still gets an RFC 9728 challenge on 401. */
export function sendHttpError(reply: FastifyReply, error: unknown, config: BridgeConfig): void {
  const oauthError = error instanceof OAuthError ? error : undefined;
  const status = oauthError?.status ?? 500;
  if (status === 401 && oauthError) reply.header("www-authenticate", buildChallenge(config, oauthError));
  reply.code(status).send(
    oauthError
      ? { error: { code: oauthError.code, message: oauthError.message } }
      : { error: { code: "internal_error", message: "Request failed" } },
  );
}

/** `/mcp` auth-failure handler: an RFC 6750/9728 `WWW-Authenticate` challenge on 401 +
 *  the captatum JSON-RPC auth-error body (`-32003`). The challenge is built by mcp-sso's
 *  `buildUnauthorizedChallenge` (RFC 9728 `resource_metadata` + the scope catalog + the
 *  OAuth error). */
export function sendMcpAuthError(reply: FastifyReply, error: unknown, config: BridgeConfig): void {
  const oauthError = error instanceof OAuthError
    ? error
    : new OAuthError(
      "invalid_token",
      "OAuth Bearer access token is invalid or expired — re-authenticate via /oauth/token",
      401,
    );
  if (oauthError.status === 401) reply.header("www-authenticate", buildChallenge(config, oauthError));
  reply.code(oauthError.status).send({
    jsonrpc: "2.0",
    error: { code: AUTH_JSONRPC_CODE, message: `${oauthError.code}: ${oauthError.message}` },
    id: null,
  });
}

function buildChallenge(config: BridgeConfig, error: OAuthError): string {
  return buildUnauthorizedChallenge(config, {
    scope: config.scopeCatalog,
    error: error.code,
    errorDescription: error.message,
  });
}

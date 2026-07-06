import type { FastifyReply } from "fastify";
import { OAuthError, bearerChallenge, oauthErrorBody } from "../../application/use-cases/oauth-errors.ts";
import { AUTH_JSONRPC_CODE } from "../jsonrpc-error-codes.ts";

export function sendHttpError(reply: FastifyReply, error: unknown): void {
  const oauthError = error instanceof OAuthError ? error : undefined;
  const status = oauthError?.status ?? 500;
  // RFC 6750 Bearer challenge (error + error_description) so a non-OAuth HTTP
  // client can tell programmatically why its request was rejected (#104).
  if (status === 401 && oauthError) reply.header("www-authenticate", bearerChallenge(oauthError));
  reply.code(status).send(httpErrorBody(error));
}

export function sendMcpAuthError(reply: FastifyReply, error: unknown): void {
  const oauthError = error instanceof OAuthError
    ? error
    : new OAuthError(
        "invalid_token",
        "OAuth Bearer access token is invalid or expired — re-authenticate via /oauth/token",
        401,
      );
  if (oauthError.status === 401) reply.header("www-authenticate", bearerChallenge(oauthError));
  reply.code(oauthError.status).send({
    jsonrpc: "2.0",
    error: { code: AUTH_JSONRPC_CODE, message: `${oauthError.code}: ${oauthError.message}` },
    id: null,
  });
}

function httpErrorBody(error: unknown): { error: { code: string; message: string } } {
  if (error instanceof OAuthError) return oauthErrorBody(error);
  return { error: { code: "internal_error", message: "Request failed" } };
}

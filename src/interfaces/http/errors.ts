import type { FastifyReply } from "fastify";
import { OAuthError, oauthErrorBody } from "../../application/use-cases/oauth-errors.ts";

export function sendHttpError(reply: FastifyReply, error: unknown): void {
  const body = httpErrorBody(error);
  const status = error instanceof OAuthError ? error.status : 500;
  if (status === 401) reply.header("www-authenticate", "Bearer");
  reply.code(status).send(body);
}

export function sendMcpAuthError(reply: FastifyReply, error: unknown): void {
  const oauthError = error instanceof OAuthError
    ? error
    : new OAuthError("invalid_token", "Bearer token is invalid", 401);
  if (oauthError.status === 401) reply.header("www-authenticate", "Bearer");
  reply.code(oauthError.status).send({
    jsonrpc: "2.0",
    error: { code: -32001, message: `${oauthError.code}: ${oauthError.message}` },
    id: null,
  });
}

function httpErrorBody(error: unknown): { error: { code: string; message: string } } {
  if (error instanceof OAuthError) return oauthErrorBody(error);
  return { error: { code: "internal_error", message: "Request failed" } };
}

export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
  }
}

export function oauthErrorBody(error: OAuthError): { error: { code: string; message: string } } {
  return { error: { code: error.code, message: error.message } };
}

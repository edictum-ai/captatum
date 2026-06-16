import { OAuthError } from "./oauth-errors.ts";

export const OAUTH_SCOPES = ["fetch:read", "fetch:transform"] as const;
export type OAuthScope = typeof OAUTH_SCOPES[number];

const SCOPE_SET = new Set<string>(OAUTH_SCOPES);

export interface AuthorizedSubject {
  subject: string;
  clientId: string;
  scopes: OAuthScope[];
}

export function normalizeScopes(scope?: string | string[] | null): OAuthScope[] {
  const values = Array.isArray(scope) ? scope : (scope ?? "fetch:read").split(/\s+/);
  const deduped: OAuthScope[] = [];
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    if (!SCOPE_SET.has(value)) {
      throw new OAuthError("invalid_scope", "Requested scope is not supported");
    }
    if (!deduped.includes(value as OAuthScope)) deduped.push(value as OAuthScope);
  }
  return deduped.length ? deduped : ["fetch:read"];
}

export function scopeString(scopes: readonly OAuthScope[]): string {
  return [...scopes].sort().join(" ");
}

export function requireScope(auth: AuthorizedSubject, required: OAuthScope): void {
  if (!auth.scopes.includes(required)) {
    throw new OAuthError("insufficient_scope", `Missing required scope: ${required}`, 403);
  }
}

export function requiredScopeForSmartFetch(input: unknown): OAuthScope {
  if (!isRecord(input)) return "fetch:transform";
  const output = typeof input.output === "string" ? input.output : undefined;
  if (output === "raw" && input.transform === undefined) return "fetch:read";
  return "fetch:transform";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

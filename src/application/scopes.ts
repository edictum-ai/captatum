// captatum's OAuth scope policy. The OAuth mechanics (catalog validation, the 403
// insufficient_scope step-up) are mcp-sso's (`requireScope`); this module owns only
// captatum's catalog + the per-call resolution of WHICH scope a captatum tool call
// requires from its effective output. Replaces the captatum-specific half of the
// removed `oauth-scopes.ts` (its `requireScope`/`AuthorizedSubject` now come from
// mcp-sso).
import type { Output } from "../domain/tier.ts";

/** captatum's OAuth scope catalog. `fetch:read` covers a raw (no-Transform) call;
 *  `fetch:transform` covers any call that runs the Transform stage (summary/extract).
 *  This is the single source of truth — `mcp-sso-config.ts` feeds it to the
 *  `BridgeConfig.scopeCatalog`. */
export const OAUTH_SCOPES = ["fetch:read", "fetch:transform"] as const;

/** Resolve the captatum scope a tool call requires from its EFFECTIVE output. A
 *  `raw` call never runs the Transform stage, even if it carries an unused transform
 *  override, so it needs only `fetch:read`; summary/extract need `fetch:transform`.
 *  The caller passes the result to mcp-sso's `requireScope`, which performs the actual
 *  403 step-up. */
export function requiredScopeForCaptatum(input: unknown, defaultOutput?: Output): string {
  if (!isRecord(input)) return "fetch:transform";
  const output = typeof input.output === "string" ? input.output : defaultOutput;
  return output === "raw" ? "fetch:read" : "fetch:transform";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

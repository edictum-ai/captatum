# Spec — Captatum auth stack → mcp-sso migration (mcp-sso S0b "Captatum dogfood")

Status: implementing. Source: `~/project/mcp-sso` roadmap session **S0b**.
Plan: `~/.claude/plans/jazzy-skipping-sprout.md`. Contract refs: `docs/contracts.md`
§"OAuth", §"Storage", §"Error shape"; `docs/threat-model.md` §"Auth Limits".

## Goal

Replace captatum's hand-rolled OAuth 2.1 stack with the **mcp-sso** library
(`mcp-sso@0.2.0`, acartag7/mcp-sso) — captatum's own OAuth, extracted + hardened into
the owner's OSS library. Captatum becomes mcp-sso's reference production consumer; the
auth implementation is maintained once (canonically) instead of as a divergent in-repo
fork. ~2.2k LOC leaves captatum.

## Scope (big-bang, one PR)

Remove:
- `src/application/use-cases/{oauth-authorization,oauth-token,oauth-crypto,oauth-errors,oauth-scopes,oauth-config,request-auth}.ts`
- `src/interfaces/http/oauth-routes.ts`, `src/infrastructure/auth/cloudflare-access-jwt.ts`
- OAuth-only storage: `src/application/ports/store.ts`,
  `src/infrastructure/{sqlite,tidb}/**`, `src/infrastructure/store-selection.ts`
- the removed code's tests: `oauth.test.ts`, `oauth-errors.test.ts`,
  `oauth-redirect.test.ts`, `cloudflare-access-jwt.test.ts`, `store.test.ts`,
  `store-selection.test.ts`

Add:
- `src/application/mcp-sso-config.ts` — env → mcp-sso `BridgeConfig` + flavor + AUTH-1 CF gate
- `src/application/local-auth.ts` — `LocalBypassAuthorizer` (stdio flavor only)
- `src/application/scopes.ts` — `requiredScopeForCaptatum` + `OAUTH_SCOPES`
- `test/mcp-sso-wiring.test.ts` — full mcp-sso flow vs a memory store

Modify: `src/server.ts` (composition root), `src/interfaces/http/{app,errors,mcp-route}.ts`,
`src/interfaces/mcp/{server,bulk-handler,local-server}.ts`, `src/application/ports/audit.ts`,
`src/dev/smoke-test.ts`, `package.json`, `pnpm-workspace.yaml`, `docs/{contracts,threat-model,dependency-ledger}.md`.

## Mapping (captatum in-house → mcp-sso)

| Removed | Replacement |
| --- | --- |
| `oauth-crypto` (sign/verify, PKCE, codes) | `mcp-sso` crypto (`signAccessToken`/`verifyAccessToken`/…) |
| `oauth-authorization` + `oauth-token` + `register` | `mcp-sso` `Bridge` |
| `oauth-routes.ts` (`registerOAuthRoutes`) | `mcp-sso/adapters/fastify` `registerOAuthRoutes` |
| `request-auth.ts` (hosted branch) | `mcp-sso` `RequestAuthorizer` |
| `cloudflare-access-jwt.ts` | `mcp-sso/identity/cloudflare-access` `createCloudflareAccessIdentity` |
| `oauth-config.ts` (`HostedOAuthConfig`) | `mcp-sso` `createBridgeConfig` (via `mcp-sso-config.ts`) |
| `oauth-errors.ts` (`OAuthError`, `bearerChallenge`) | `mcp-sso` `OAuthError` + `buildUnauthorizedChallenge` |
| `oauth-scopes.ts` (`requireScope`) | `mcp-sso` `requireScope` |
| `ports/store` + `sqlite/` + `tidb/` + `store-selection` | `mcp-sso/store/{sqlite,mysql}` |

## What stays captatum-specific (small)

- **Flavor** (`CAPTATUM_FLAVOR=hosted|local-binary`) + `assertHostedFlavor`/`assertLocalFlavor`.
- **AUTH-1 CF-Access-required boot gate** (`assertHostedCloudflareAccess`) — captatum keeps
  this; mcp-sso's CF identity port checks audience/https but not `CF_ACCESS_ENABLED`.
- **Scope policy**: `requiredScopeForCaptatum` (raw→`fetch:read` / else `fetch:transform`)
  + `OAUTH_SCOPES = ["fetch:read","fetch:transform"]`; calls mcp-sso's `requireScope`.
- **`LocalBypassAuthorizer`** (stdio flavor) — mcp-sso's `RequestAuthorizer` has an explicit
  no-bypass policy, so captatum keeps a tiny bypass authorizer, structurally gated to the
  local-binary stdio bridge (never the hosted HTTP path).
- **`AuditLoggerPort`** (keeps `writeToolEvent`) + a `writeAuthEvent` typed to satisfy mcp-sso's
  `AuditPort` — one unified audit log.

## Behavior preserved vs changed

- **Preserved (the OAuth flow):** DCR/PKCE/CF-Access flow, endpoints, scopes, token shape
  (ES256 JWT, aud=resource), rotating refresh tokens + family replay revocation, TTLs.
  Verified equivalent by reading both codebases.
- **One client-visible change — `WWW-Authenticate` challenge syntax.** mcp-sso emits the
  RFC 9728 form `Bearer resource_metadata="<PRM URL>", scope="…", error="…",
  error_description="…"` (built by `buildUnauthorizedChallenge`). The prior captatum-specific
  `realm="captatum"` form — including its realm-only-on-no-credentials distinction — is
  retired. RFC 9728 `resource_metadata` is the more standards-compliant + self-discovering
  form (a client fetches the PRM doc to discover the AS) and is mcp-sso's canonical behavior.
  The human remedy still rides the JSON-RPC `message`. The JSON-RPC auth-failed code
  (`-32003`) is unchanged.
- **Store schema:** identical tables (mcp-sso was extracted from captatum), but the store is
  now the library's. Existing refresh tokens are invalidated (schema ownership move);
  personal-prod clients re-auth once.

## Verification bar (no prod flip until all pass)

`pnpm run check` (syntax + 250-line + typecheck) · `pnpm test` (unit) ·
`node --test test/integration/fixtures.test.ts` (real Chromium, auth-unaffected) ·
`pnpm run smoke` · `pnpm run test:acceptance` · process-guard ·
`test/mcp-sso-wiring.test.ts` (register→authorize→token→`/mcp` 200→401→challenge).
Live: Mac mini `/healthz` + curl full flow + ≥1 real client (Claude Code; aim claude.ai +
ChatGPT) before declaring done. Version **0.16.0** (minor — auth-stack migration + new dep;
client OAuth flow unchanged, so not a major).

## Dependency note

`mcp-sso@0.2.0` is the only new direct dep (3 days old as of 2026-07-10). Its single runtime
dep `jose@6.2.3` is already pinned; `mysql2@3.22.3` (already pinned) backs the TiDB store.
On `minimumReleaseAgeExclude: ["mcp-sso"]` — a scoped **own-package** exception (the 15-day
rule guards against stranger supply-chain compromise, inapplicable to the owner's own
freshly-published library); the global rule is unchanged. Tarball verified to ship `dist/`.
See `docs/dependency-ledger.md`.

# Contracts

Tracks the public and internal contracts for smart-fetch. Update this file **before** changing any tool, port, schema, endpoint, or error shape. v0: fields may be added freely; renaming or removing a field is a breaking change and must be noted here.

## Versioning

Current contract version: `v0`.

## Product

smart-fetch is a general-purpose MCP fetch tool for AI agents: fetch **any** URL (rendering JS when needed) and return **token-efficient** content plus **provenance** describing how the result was produced. The goal is to give agents what Claude Code's built-in `WebFetch` gives them — a concise answer about a page — but **token-efficient** (the default output is a summary produced via the free-model router), with the ability to return **raw** content on request, and actually working on JS-rendered pages.

Why it beats `WebFetch`: `WebFetch` is a static GET + Turndown (which drops `<script>` JSON-LD and app state) + a Haiku summary, with no JS execution. smart-fetch uses anti-bot TLS-fingerprinted fetch (`wreq-js`), renders JS when a page needs it, extracts structured data from **raw** HTML, defaults to a token-efficient summary (free models via OpenRouter, or local Ollama), can return raw content on demand, and reports provenance on every response.

## Protocol

- MCP protocol: support `2025-11-25` clients; **write the server in the `2026-07-28` RC style now** (stateless, self-contained requests), mirroring `personal-memory-gateway`'s investigation (runbook §"2026-07-28 RC changes that matter": no protocol sessions / `MCP-Session-Id`, no `initialize`, per-request auth, request metadata in `_meta.io.modelcontextprotocol/*`, `server/discover`, `subscriptions/listen` over long-lived POST, HTTP+SSE deprecated; `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers matter). Do not depend on sessions or `initialize` for security.
- Transport: **Streamable HTTP** at `POST /mcp` (stateless: `sessionIdGenerator: undefined`, `enableJsonResponse: true`). `GET/DELETE /mcp` → 405.
- `GET /healthz` is the only unauthenticated route → `{ status: "ok" }`.
- Every `/mcp` request is authenticated and authorized independently. Session IDs are never auth.
- **Deployment is the primary path**: a hosted remote server reachable from every client, including web agents (claude.ai, chatgpt.com), which **cannot** use a stdio bridge. The local **stdio bridge** (`src/interfaces/mcp/stdio-bridge.ts`) is a secondary/legacy client adapter that proxies to the remote `/mcp`; it is **not** an auth boundary and does not serve web agents.
- Auth is conditional on deployment flavor (see OAuth / Deployment): the hosted flavor requires gateway OAuth bearer tokens; a self-contained local-binary flavor runs without auth.
- Inbound Host/Origin DNS-rebinding protection via the SDK transport (`enableDnsRebindingProtection`, `allowedHosts`, `allowedOrigins`).

## Tool: `smart_fetch`

One tool. Input (v0):

| Field | Required | Notes |
| --- | --- | --- |
| `url` | yes | Fully-formed `http`/`https`. `http` upgraded to `https`. No userinfo. |
| `prompt` | no | What the caller wants from the page (drives the default `summary`). Mirrors WebFetch. Defaults to a general summary. |
| `output` | no | `summary` (default) \| `raw` \| `extract`. `summary` = token-efficient answer via the Transform router. `raw` = clean resolved content, no LLM. `extract` = structured JSON per `schema`. |
| `schema` | no | JSON schema for `output: extract`. |
| `budget` | no | Max tokens for `summary`. |
| `transform` | no | Override the default router/model/provider: `{ model?, provider?, ... }`. |
| `maxBytes` | no | Response byte cap (decompressed). Default 5 MB, server hard-capped. |
| `timeoutMs` | no | Per-tier wall-clock. Default 15 s (Tier-1/2), 20 s (Tier-3). |
| `allowRender` | no | Default **false**. If false, Tier-3 is skipped and provenance reports `renderBlocked`. |

**Default behavior is `output: summary`** — resolved content is passed through the Transform router (free-first OpenRouter, or local Ollama) to produce a token-efficient answer to `prompt`. This is exactly the role WebFetch's Haiku step plays, but cheaper and fed by accurate rendered/extracted content. `output: raw` returns the clean resolved content (markdown + parsed structured data) with no LLM pass. Output is MCP `text` with a provenance footer as the first line (HTML-comment-wrapped, always model-visible), mirrored as `structuredContent` per the Result schema. Token-efficiency signals (`bytes`, `truncated`, `contentType`, `transform.inTokens/outTokens`) let the caller follow up.

## Provenance / Result schema

Extends WebFetch's output shape (`bytes`, `code`, `codeText`, `result`, `durationMs`, `url`) so it's familiar to agents/clients, then adds provenance:

```
Result {
  // WebFetch-compatible core
  url,                        // requested URL
  bytes,                      // fetched content size (bytes)
  code, codeText,             // HTTP status of the final response
  durationMs,                 // total wall-clock
  result,                     // payload the agent consumes: summary text (default), raw content, or extracted JSON
  // smart-fetch provenance
  schemaVersion: 1,
  finalUrl, redirects: [{ url, status }],
  tier: 1 | 2 | 3 | "none" | "error" | "render-unavailable" | "render-blocked",
  output: "summary" | "raw" | "extract",
  platform: { adapterId, label, detectedFrom },   // adapterId may be "generic"
  jsRequired: boolean,
  resolvedVia: string,                            // e.g. "tier1-jsonld", "tier3-playwright"
  attempts: [{ step, tier, outcome, status?, durationMs, bytes?, reason? }],
  contentType,
  title,                                          // when derivable
  structured: { jsonLd?, og?, meta?, appState? }, // parsed from raw HTML (present when found)
  transform: { provider, model, free, inTokens, outTokens, latencyMs, costUsd? }, // present on summary/extract
  timings: { totalMs, fetchMs, renderMs?, transformMs? },
  errors: [{ code, message }],
}
```

Timestamps are caller-injected (`fetchedAt?: string`). No `Date.now()` in core (CI grep enforces).

## Ports

- **`FetcherPort`** — the single hardened egress. `fetchGuarded(url, opts) → { status, finalUrl, redirects, bodyStream, contentType, bytes } | RejectResult`. Every outbound request (Tier-1, Tier-2 adapter, every redirect hop, every Tier-3 in-browser request) routes through it.
- **`PlatformAdapter`** — `{ id, detect(ctx): DetectResult | null, resolve(input, fetcher): Promise<ResolveResult> }`. Registered in `src/application/adapters.ts`. Optional general-purpose extension point: adding a platform = one folder under `src/infrastructure/<platform>/` + one registry line + one fixture. Not part of the public contract.
- **`StorePort`** — OAuth state only (hosted flavor): auth-code records and refresh-token records (hashed), plus `close()`. Implemented by `src/infrastructure/sqlite/` over `node:sqlite`.
- **`ModelRouterPort`** — `pick(task, inputTokens): { provider, model }` + `feedback(model, score)` for the bandit. Implemented by `src/infrastructure/llm/model-router.ts`.

## Tiers

- **Tier-1 (default).** `wreq-js` fetch (browser TLS/JA3+JA4 fingerprint impersonation → anti-bot) + raw-HTML extraction: JSON-LD `<script application/ld+json>`, Open Graph/twitter meta, canonical, and embedded app state (`__NEXT_DATA__`, `__INITIAL_STATE__`) via a prototype-pollution-safe reviver. A **shell-gate** decides whether the page has real content (→ done) or is an empty SPA shell (→ escalate). Generic main-content extraction may use `defuddle` when added.
- **Tier-2 (optional).** If a registered `PlatformAdapter` detects the URL, it resolves via that platform's public API (clean JSON), short-circuiting extraction/render. Adapters are optional and general; their endpoints live in adapter code/fixtures, not this contract.
- **Tier-3 (core, gated by `allowRender`).** Lazy `import('playwright')`; one warm browser context per process; render with hard timeouts + request interception (abort image/font/media/analytics, block private IPs at the browser network layer, close websockets, disable Service Workers, block downloads); reuse the Tier-1 extractor on `page.content()` and inject Readability.js via `page.evaluate` for main content. Chromium pinned to version+digest. If Playwright is absent → `render-unavailable`. **When it applies:** Tier-3 fires when Tier-1 finds an empty SPA shell or no usable structured data — e.g. client-rendered React/Vue/Svelte apps whose HTML is a `<div id="root">` stub; pages that load content via XHR/fetch after `load`; JS-only docs/demos (Docusaurus/Storybook in SPA mode); content behind a Cloudflare/anti-bot interstitial that needs a real browser; and embedded widgets rendered client-side on a third-party domain (e.g. an Ashby board). Gated by `allowRender` (default false) so a bare `smart-fetch` never spawns a browser.

## Transform (default output path)

The Transform stage is the **default** output path (`output: summary`): resolved content is turned into a token-efficient answer to `prompt` — the role WebFetch's Haiku step plays, but fed by accurate rendered/extracted content and routed through the free-model router so it's cheap.

Modes: `summarize` (default — concise answer to `prompt`, optionally to a token `budget`) and `extract` (structured JSON per `schema`). `output: raw` skips the LLM and returns clean resolved content.

Provider-configurable via `transform`: **OpenRouter** (default; OpenAI-compatible `chat/completions` over plain `node:https`, key from config) or **local Ollama** (zero egress). The model router enforces a policy hosted routers won't: free-first (`pricing.prompt=="0"`), per-request fit (context length, text modality — filter out audio/coding/image models, JSON-schema support for `extract`), with a **feedback bandit** (score each result: valid JSON? in-budget? non-empty? latency → per-model EMA → flaky/garbage self-demotes) and a fallback chain: best free → cheap paid (Flash/Haiku) → local Ollama. Provenance records `{provider, model, free, inTokens, outTokens, latencyMs}`. On failure, fall back to raw content + a provenance flag.

Privacy: fetched content is mostly public web content; the only egress risk is non-public content (authed/signed URLs, internal hosts) → detect via signals and route to Ollama or skip.

**Setup & fallback.** Configure `OPENROUTER_API_KEY` (OpenRouter) and/or `OLLAMA_BASE_URL` (local Ollama) in the environment; the router uses whichever is configured (OpenRouter default, Ollama override for sensitive/local). An MCP tool **cannot** see or use the calling agent's own model or credentials, so there is no "use the caller's model" path. **If no transform provider is configured, `output: summary` degrades to `output: raw`** (clean resolved content, no LLM) and provenance records `transform: { provider: "none", reason: "unconfigured" }`. Because summary is the default output, this setup is first-run-critical and must be documented prominently in the tool description and `docs/`.

## OAuth (hosted flavor only)

Auth is **conditional on deployment flavor** (see Deployment). Two flavors:
- **Hosted remote server** (primary) — requires the gateway-owned OAuth below, so it can serve web agents (claude.ai, chatgpt.com) and shared users.
- **Self-contained local binary** — runs without auth for a single agent/user on one machine.

The OAuth contract below applies only to the hosted flavor. It mirrors `personal-memory-gateway`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/.well-known/oauth-authorization-server` | AS metadata |
| GET | `/.well-known/oauth-protected-resource` | Protected-resource metadata |
| GET | `/oauth/jwks` | Public JWKS (`cache-control: public, max-age=60`) |
| POST | `/oauth/register` | Dynamic Client Registration |
| GET | `/oauth/authorize` | Prepare consent; set signed consent cookie |
| POST | `/oauth/authorize/approve` | Verify consent token; issue single-use auth code; 302 `?code=&iss=&state=` |
| POST | `/oauth/token` | `authorization_code` / `refresh_token` grant (`cache-control: no-store`) |
| POST | `/oauth/revoke` | Revoke refresh-token family; always 200 |

Flow: authorize (PKCE S256, request-bound signed consent token) → approve (single-use code, stored as `sha256(code)`) → token (verify PKCE, issue **ES256 JWT** access token signed by `OAUTH_SIGNING_PRIVATE_JWK`, aud=resource; rotating refresh tokens stored as `sha256(raw)`, grouped by family; replay revokes the family). Access TTL 600 s; refresh TTL 30 days. Hosted production requires `OAUTH_CONSENT_SIGNING_SECRET` + `OAUTH_SIGNING_PRIVATE_JWK` (fail-fast at boot).

Scopes: `fetch:read` (default), `fetch:transform` (to use the Transform stage). Tool handlers enforce required scope per request.

## Security controls (see threat-model.md)

- OUTBOUND rebinding-proof `guardedFetch`: scheme `http|https` only; reject raw CRLF; strip userinfo; resolve → `isPrivate` CIDR (v4 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16 incl. metadata, 0.0.0.0/8, 100.64/10, 224/4; v6 ::1, fe80/10, fc00/7, ff00/8, `::ffff:0:0/96`, NAT64 `64:ff9b::`, IPv4-compatible) → connect to the resolved IP (`node:https` with `servername`/`Host` = original host); manual redirects re-validated each hop (`maxHops=5`); decompressed-byte cap; `AbortController` timeout.
- INBOUND: SDK transport Host/Origin DNS-rebinding protection.
- TIER-3 in-browser SSRF: `page.route` isPrivate on every subresource; websocket-close; SW off; downloads blocked; render-byte cap; browser in a separate child process with no env; OS sandbox on (never `--no-sandbox`).
- Response guards: reject `Content-Length` > max before reading; stream through a counting `TransformStream`.
- Logging: allow-list only (tier, finalUrl, platform, status, bytes, timing, blockReason); never body, never `Set-Cookie`/`Authorization`; canonicalize logged URLs to scheme+host when host is private. Per-call audit event.
- Per-host throttle + global concurrency cap + in-flight URL dedupe + per-job max-egress-fetch counter.

## Storage

OAuth state only (auth codes + refresh tokens, hashed), behind a swappable `StorePort` with one implementation per flavor:
- **Hosted flavor → reuse the existing TiDB** from `personal-memory-infra` (EC2 `REDACTED_INSTANCE`, private `REDACTED_TIDB_HOST:4000`, MySQL protocol): add a new `smartfetch` database + a restricted `smartfetch_rw` user, and a TiDB-SG rule allowing smart-fetch's task SG on `4000/tcp` — mirroring how `personal-memory-gateway` connects (`mysql2`, `TIDB_HOST/PORT/DATABASE/USER/PASSWORD`). No new database server.
- **Local-binary flavor → embedded `node:sqlite`** (file on disk, no server).

Tables: `oauth_auth_codes` (codeHash, clientId, subject, redirectUri, resource, scopes, codeChallenge, expiresAt) and `oauth_refresh_tokens` (tokenHash, familyId, previousTokenHash, clientId, subject, scopes, expiresAt). No storage for fetched content — the service is stateless otherwise. Schema via SQL migrations (per flavor).

## Error shape

All HTTP/JSON-RPC errors:

```
{ "error": { "code": "snake_case", "message": "human text" } }   // HTTP
{ "jsonrpc":"2.0", "error": { "code": -32001, "message": "..." }, "id": null }  // auth-failed JSON-RPC
```

Stable `code` values; `message` may change. Auth failure sets `WWW-Authenticate`.

## Audit event

One per tool call: `{ occurredAt, subject?, clientId?, tool:"smart_fetch", url_host (scheme+host only), tier, platform, output, status, bytes, durationMs, transformProvider?, transformModel? }`. Never includes body, full URL path/query for private hosts, tokens, or credentials.

## Deployment

Everything in this contract is the product — nothing is version-gated or "deferred"; it all gets built. Two deployment flavors off one core engine:
- **Hosted remote server** (primary): Streamable HTTP `/mcp` + gateway OAuth, reachable from all clients including web agents (claude.ai, chatgpt.com). Containerized (mirror `personal-memory-gateway`'s ECS/cloudflared path).
- **Self-contained local binary**: the same engine compiled (Bun `--compile`) into one executable an agent runs locally — no deployment, no auth, single-user/single-agent use. (wreq-js native prebuilts bundle alongside.)

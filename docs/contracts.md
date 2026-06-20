# Contracts

Tracks the public and internal contracts for smart-fetch. Update this file **before** changing any tool, port, schema, endpoint, or error shape. v0: fields may be added freely; renaming or removing a field is a breaking change and must be noted here.

## Versioning

Current contract version: `v0`.

## Product

smart-fetch is a general-purpose MCP fetch tool for AI agents: fetch **any** URL (rendering JS when needed) and return **token-efficient** content plus **provenance** describing how the result was produced. The goal is to give agents what Claude Code's built-in `WebFetch` gives them — a concise answer about a page — but **token-efficient** (the default output is a summary produced via the free-model router), with the ability to return **raw** content on request, and actually working on JS-rendered pages.

Why it beats `WebFetch`: `WebFetch` is a static GET + Turndown (which drops `<script>` JSON-LD and app state) + a Haiku summary, with no JS execution. smart-fetch uses anti-bot TLS-fingerprinted fetch (`wreq-js`), renders JS when a page needs it, extracts structured data from **raw** HTML, defaults to a token-efficient summary (free models via OpenRouter, or local Ollama), can return raw content on demand, and reports provenance on every response.

## Protocol

- MCP protocol: support `2025-11-25` clients; **write the server in the `2026-07-28` RC style where the pinned SDK permits** (stateless, self-contained requests), mirroring `personal-memory-gateway`'s investigation. Do not depend on sessions or `initialize` for security.
- Compatibility note for the pinned `@modelcontextprotocol/sdk@1.29.0`: its latest supported protocol is `2025-11-25`, not the forward `2026-07-28` RC. The hosted server therefore implements the compatible forward pieces only: fresh server + fresh Streamable HTTP transport per `POST /mcp`, `sessionIdGenerator: undefined`, `enableJsonResponse: true`, per-request bearer auth before MCP dispatch, and no `MCP-Session-Id` auth. SDK features not exposed in this pin, such as `server/discover` and `subscriptions/listen`, are not implemented yet. SDK 1.29.0 also requires clients to send an `Accept` header that includes both `application/json` and `text/event-stream`.
- Transport: **Streamable HTTP** at `POST /mcp` (stateless: fresh transport per request, `sessionIdGenerator: undefined`, `enableJsonResponse: true`). `GET/DELETE /mcp` → 405.
- `GET /healthz` is the only unauthenticated route → `{ status: "ok" }`.
- Every `/mcp` request is authenticated and authorized independently. Session IDs are never auth.
- The repo ships two runtime entrypoints over the same core engine. The hosted
  Streamable HTTP server is implemented locally and covered by authenticated
  route/smoke tests; public deployment packaging/infrastructure is outside this
  repo slice. When deployed with OAuth, that hosted HTTP flavor is the path web
  agents can use. The local **stdio bridge**
  (`src/interfaces/mcp/stdio-bridge.ts`) is the self-contained local-binary
  entrypoint: it runs the **same** core engine in-process over an
  `StdioServerTransport` (`@modelcontextprotocol/sdk/server/stdio.js`) for a
  single local agent. It has **no OAuth**, opens **no network listener**, and is
  **not** a remote proxy. It reuses the hosted `smart_fetch` use case and tool
  schema unchanged (`src/interfaces/mcp/local-server.ts` builds the same MCP
  server the `POST /mcp` route serves, with single-user local auth). It refuses
  to start under the `hosted` flavor (fails loudly rather than exposing an
  unauthenticated surface), and all logs go to stderr so stdout stays the
  JSON-RPC channel. It does not serve web agents — they require the hosted HTTP
  server.
- Auth is conditional on deployment flavor (see OAuth / Deployment): the hosted flavor requires gateway OAuth bearer tokens; a self-contained local-binary flavor runs without auth.
- Inbound Host/Origin DNS-rebinding protection via the SDK transport (`enableDnsRebindingProtection`, `allowedHosts`, `allowedOrigins`). Hosted boot requires explicit `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS`; local defaults are loopback-only.

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
| `allowRender` | no | Default **false**. If false, Tier-3 is skipped and provenance reports `render-blocked`. |
| `debug` | no | Default **false**. When true, the MCP `structuredContent` adds heavy diagnostic fields (`attempts`, `timings`, full `structured` incl. JSON-LD `description`/`articleBody`, `redirects`, `durationMs`, `httpContentType`, `contentSha256`, `provenanceHash`, verbose `transform`). Default payload is lean (see "MCP structuredContent"). |

**Default behavior is `output: summary`** — resolved content is passed through the Transform router (free-first OpenRouter, or local Ollama) to produce a token-efficient answer to `prompt`. This is exactly the role WebFetch's Haiku step plays, but cheaper and fed by accurate rendered/extracted content. `output: raw` returns the clean resolved content (markdown + parsed structured data) with no LLM pass. Output is MCP `text` with a provenance line as the first line (HTML-comment-wrapped, always model-visible). The companion `structuredContent` is a **lean agent payload** (see "MCP structuredContent"), not the full Result — heavy fields are gated behind `debug`. Token-efficiency signals (`bytes`, `contentType`, `transform.inTokens/outTokens`) let the caller follow up.

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
  structured: { canonicalUrl?, jsonLd?, og?, meta?, appState?, images? }, // parsed from raw HTML (present when found); images = bounded absolute http(s) image URLs (og:image*, JSON-LD image/ImageObject, <img>/<source srcset>); private/localhost hosts stripped, never fetched by this service
  transform: { provider, model?, free?, inTokens?, outTokens?, latencyMs?, costUsd?, reason?, schemaIssue? }, // present on summary/extract or fallback; schemaIssue carries the non-fatal extract-schema advisory message
  timings: { totalMs, fetchMs, renderMs?, transformMs? },
  errors: [{ code, message }],
}
```

Timestamps are caller-injected (`fetchedAt?: string`). No `Date.now()` in core (CI grep enforces).

When guarded fetch rejects before any HTTP response is safely available, the
core still returns a contract-shaped `Result`: `code: 0`,
`codeText: "FETCH_REJECTED"`, `tier: "error"`, `resolvedVia:
"guarded-fetch"`, `errors[0]` preserves the original guarded-fetch
`{ code, message }`, and extraction/render/transform are not called.

## MCP structuredContent (agent-facing, lean)

The `Result` above is the **internal** record (full provenance, used by tests,
the audit log, and `debug` mode). What the tool returns as MCP
`structuredContent` is a **lean agent payload** built from that Result: it keeps
the load-bearing primitives agents/connectors already read at the same paths
(`result`, `tier`, `title`, `output`, `code`, `bytes`, `platform`, `errors`,
lean `transform`) and adds a tiered envelope, while gating the heavy diagnostic
fields behind `debug: true`. The MCP `text` content (provenance line + result)
is unchanged either way — that is the primary agent channel.

Default (lean) `structuredContent`:

```
{
  schemaVersion: 1,
  ok: boolean,                         // status !== "fail"
  status: "pass" | "partial" | "fail",
  url, finalUrl, title, output,
  contentType: "article" | "job" | "pin" | "product" | "spa" | "unknown",   // classified from JSON-LD @type / og:type / host / jsRequired (distinct from the raw HTTP contentType)
  result,                              // summary text | raw content | extracted JSON (string)
  tier, code, codeText, bytes,         // kept for existing consumers
  resolvedVia, platform, jsRequired,
  access: { mainContentAccessible, gated, gateReason: "paywall"|"login"|"captcha"|"byte_cap"|"none" },
  provenance: { tier, resolvedVia, code, bytes },     // convenience envelope
  warnings: [{ code, message }],       // non-fatal (tier !== "error"): advisories, render-failed-but-tier1-ok, byte-cap truncation, extract_schema_invalid
  images: ["https://…"],               // bounded absolute http(s) URLs for optional multimodal vision fetch
  errors: [{ code, message }],         // fatal only (tier === "error")
  transform: { provider, model?, free?, inTokens?, outTokens? },   // lean token-efficiency signal; present when a transform ran
}
```

Rules:
- **errors vs warnings:** fatal ⟺ `tier === "error"` (per the note above: "advisory entries never set `tier: error`"). Everything else in `Result.errors` becomes a `warning`.
- **status:** `fail` when `tier === "error"` or no body content was returned; `partial` when content was returned but warnings exist or the summary/extract transform fell back to raw (`transform.provider === "none"`); else `pass`.
- **access.gateReason:** `paywall` when JSON-LD declares `isAccessibleForFree: false`; `byte_cap` when the response was truncated at the cap; `login` when no content was returned on a page that needed JS we could not run (render-blocked/render-unavailable/`jsRequired`); else `none`.
- **contentType:** `pin` for pinterest.*/pin.it hosts; else from the first content-bearing JSON-LD `@type` (`JobPosting`→job, `Product`→product, Article family→article); else `og:type`; else `spa` when `jsRequired`; else `unknown`.
- **images:** never fetched by this service — surfaced for the calling agent's optional vision fetch. Private/loopback hosts are stripped (string check, no DNS).

`debug: true` adds the heavy fields (`attempts`, `timings`, full `structured`
including JSON-LD `description`/`articleBody`, `redirects`, `durationMs`,
`httpContentType`, `contentSha256`, `provenanceHash`, and the verbose `transform`
with `latencyMs`/`costUsd`/`schemaIssue`) and replaces the lean `transform` with
the full one. The lean payload never carries the full `structured` blob, so
JSON-LD `description`/`articleBody` no longer duplicate the `result` text by
default. The lean `transform` keeps `reason` (the small fallback signal that
distinguishes a real summary from a silent raw fallback); only `latencyMs`/
`costUsd`/`schemaIssue` are debug-gated.

**v0 wire-shape evolution (noted breaking changes vs the previous default
`structuredContent`):** under v0 (fields may be added freely; removals/renames
are breaking and noted here) the default payload now (a) drops `timings` and the
`structured` blob (moved behind `debug`), (b) moves non-fatal advisories out of
`errors` into `warnings` (so `errors` now holds fatal entries only — `tier:
"error"`), and (c) trims `transform` to the lean fields above. The MCP `text`
channel and the load-bearing primitives (`result`, `tier`, `title`, `output`,
`code`, `bytes`, `platform`, `errors` for fatal cases) are unchanged. Consumers
that read `structuredContent.timings`, `structuredContent.structured`, or
success-tier `errors` should pass `debug: true` or read `warnings`. The domain
`Result` and its `schemaVersion: 1` are unchanged — only the presentation changed.

`access.gateReason: "captcha"` is reserved in the union but not yet emitted (no
detector); captcha/challenge pages currently fall to `"login"` or `"none"`.

## Ports

- **`FetcherPort`** — the single hardened egress. `fetchGuarded(url, opts) → { status, finalUrl, redirects, bodyStream, contentType, bytes } | RejectResult`. Every outbound request (Tier-1, Tier-2 adapter, every redirect hop, every Tier-3 in-browser request) routes through it.
- **`PlatformAdapter`** — `{ id, detect(ctx): DetectResult | null, resolve(input, fetcher): Promise<ResolveResult> }`. Registered in `src/application/adapters.ts`. Optional general-purpose extension point: adding a platform = one folder under `src/infrastructure/<platform>/` + one registry line + one fixture. Not part of the public contract.
- **`StorePort`** — OAuth state only: auth-code records and refresh-token records
  (hashed), plus `close()`. Implemented by `src/infrastructure/tidb/` over
  `mysql2` for the hosted flavor. A `node:sqlite` implementation is also
  shipped and tested for local/dev OAuth-state use, but the current local stdio
  bridge has no OAuth and does not open a store.
- **`ModelRouterPort`** — `pick(task, inputTokens, options?): { provider, model?, free?, reason? }` + `feedback(model, score)` for the deterministic feedback EMA. `options.localOnly` is used for sensitive-content signals so hosted providers are bypassed. Implemented by `src/infrastructure/llm/model-router.ts`.

## Tiers

- **Tier-1 (default).** `wreq-js` fetch (browser TLS/JA3+JA4 fingerprint impersonation → anti-bot) + raw-HTML extraction: JSON-LD `<script application/ld+json>`, Open Graph/twitter meta, canonical, and embedded app state (`__NEXT_DATA__`, `__INITIAL_STATE__`) via a prototype-pollution-safe reviver. Tier-1 egress is still behind `FetcherPort`; direct `wreq-js` calls are not allowed to bypass guarded DNS/IP checks. A **shell-gate** decides whether the page has real content (→ done) or is an empty SPA shell (→ escalate). Generic main-content extraction uses a hand-rolled visible-text extractor; `defuddle` was **evaluated and not added** — empirical probes against rendered SPAs (Vue/Angular RealWorld, TodoMVC) showed the existing extractor already yields clean main content, and a DOM-parser dependency would expand the untrusted-HTML parse surface without justification (house rule: minimal deps). The `<title>` is derived from JSON-LD when a content-bearing node (JobPosting/Article/…) carries a more specific title than the page `<title>` — fixes embedded-widget/iframe pages whose `<title>` is the host page. When multiple content-bearing JSON-LD nodes are present, the **first in document order wins** (treated as the page's primary content); this is a deliberate heuristic, not a type ranking.
  Limitation (security-required, not a deferral): `wreq-js` is used only for
  plain HTTP; HTTPS delegates to the Node requester, so `wreq-js` TLS/JA3+JA4
  fingerprinting is not active for HTTPS. `wreq-js` exposes no connect-to-
  resolved-IP or custom-DNS option — its `RequestInit` offers only `proxy`/
  `browser`/`os`/`insecure`/`transport`, and DNS is resolved internally in the
  native layer. Using it for HTTPS would force an unsafe choice: let wreq
  self-resolve (a **rebinding SSRF hole** — the guard checks IP A, wreq may
  connect to IP B) or set `insecure: true` (a **MITM hole** — disables cert
  verification). The rebinding-proof SSRF guarantee is non-negotiable, so HTTPS
  keeps the checked-IP Node path. Revisit only if `wreq-js` adds a connect-to-IP
  or custom-resolver API.
- **Tier-2 (optional).** If a registered `PlatformAdapter` detects the URL, it resolves via that platform's public API (clean JSON), short-circuiting extraction/render. Adapters are optional and general; their endpoints live in adapter code/fixtures, not this contract.
- **Tier-3 (core, gated by `allowRender`).** Lazy `import('playwright')`;
  render with hard timeouts + request interception. Document/script/fetch/XHR/
  stylesheet requests route through `FetcherPort`; image/font/media/analytics
  URLs are checked with the same P1 URL/DNS private-IP guard and then aborted;
  websockets are closed; Service Workers are disabled; downloads are blocked;
  cumulative browser fetch bytes are capped. Final rendered HTML bytes that
  exceed the cap are **truncated** (UTF-8-safe) and surfaced as a non-fatal
  `max_bytes` provenance note rather than rejecting the render — the bytes are
  already in memory, so a truncated render beats throwing it away. The Tier-1
  fetch-path byte cap remains a **hard reject** (a pre-download bandwidth/abuse
  guard). The
  rendered `page.content()` is reused by the Tier-1 extractor and provenance
  records tier 3 plus browser control actions (`service-workers-disabled`,
  `request-blocked`, `resource-aborted`, `websocket-closed`,
  `download-blocked`). The browser runs with an empty environment. **Two acquisition modes** (factory `createRenderer()`, config-driven): (a) **CDP sidecar** — connect to a long-lived Chromium in its OWN container via `CAPTATUM_BROWSER_CDP_ENDPOINT` (the hosted path; connection cached + reused, never closed per-render; `--no-sandbox` is acceptable there because the container is the isolation boundary); (b) **in-process launch** — `chromiumSandbox` defaults **true** (the local-binary path; `--no-sandbox` in-process is only a transitional opt-in via `CAPTATUM_BROWSER_INPROCESS_SANDBOX=false`). Either way the browser never runs in-process with `--no-sandbox` against the gateway's blast radius. The `page.route` SSRF guard applies identically in both modes. If Playwright is
  absent → `render-unavailable`. **When it applies:** Tier-3 fires when Tier-1
  finds an empty SPA shell or no usable structured data — e.g. client-rendered
  React/Vue/Svelte apps whose HTML is a `<div id="root">` stub; pages that load
  content via XHR/fetch after `load`; JS-only docs/demos (Docusaurus/Storybook
  in SPA mode); content behind a Cloudflare/anti-bot interstitial that needs a
  real browser; and embedded widgets rendered client-side on a third-party
  domain (e.g. an Ashby board). Gated by `allowRender` (default false) so a bare
  `smart-fetch` never spawns a browser.

## Transform (default output path)

The Transform stage is the **default** output path (`output: summary`): resolved content is turned into a token-efficient answer to `prompt` — the role WebFetch's Haiku step plays, but fed by accurate rendered/extracted content and routed through the free-model router so it's cheap.

Modes: `summarize` (default — concise answer to `prompt`, optionally to a token `budget`) and `extract` (structured JSON per `schema`). `output: raw` skips the LLM and returns clean resolved content.

`extract` validates the provider's JSON before returning it. The validator enforces the supported JSON Schema subset used by this tool (`type`, `required`, `properties`, `additionalProperties`, `items`, `enum`/`const`, string length/pattern, numeric bounds, array/property counts, uniqueness, and `allOf`/`anyOf`/`oneOf`/`not`) and fails closed with `extract_schema_invalid` for unsupported validation keywords instead of accepting schema-invalid output. For **supported** keywords, a value mismatch (wrong type, `minLength`, etc.) is **advisory**: the parsed JSON is still returned (imperfect structured data > raw fallback) but the mismatch is surfaced as a non-fatal `extract_schema_invalid` error so the caller is not silently handed schema-violating data.

Provider-configurable via `transform`: **OpenRouter** (default; OpenAI-compatible `chat/completions` over plain `node:https`, key from config) or **local Ollama** (zero egress). The model router enforces a policy hosted routers won't: free-first (`pricing.prompt=="0"`), per-request fit (context length, text modality — filter out audio/coding/image models, JSON-schema support for `extract`), with deterministic **feedback EMA** (score each result: valid JSON? in-budget? non-empty? latency → per-model EMA → flaky/garbage self-demotes) and a fallback chain: best free → cheap paid (Flash/Haiku) → local Ollama. Provenance records `{provider, model, free, inTokens, outTokens, latencyMs}`. On failure, fall back to raw content + a provenance flag.

Privacy: fetched content is mostly public web content; the only egress risk is non-public content (authed/signed URLs, internal hosts) → detect via signals and route to Ollama or skip.

**Setup & fallback.** Configure `OPENROUTER_API_KEY` (OpenRouter) and/or `OLLAMA_BASE_URL` (local Ollama) in the environment; `OPENROUTER_MODELS` overrides the comma-separated OpenRouter fallback list, `OPENROUTER_BASE_URL` overrides the API base, `OLLAMA_MODEL` selects the local model, and `TRANSFORM_TIMEOUT_MS` sets provider-call timeouts. The router uses whichever is configured (OpenRouter default, Ollama override for sensitive/local). An MCP tool **cannot** see or use the calling agent's own model or credentials, so there is no "use the caller's model" path. **If no transform provider is configured, `output: summary` degrades to `output: raw`** (clean resolved content, no LLM) and provenance records `transform: { provider: "none", reason: "unconfigured" }`. If a configured transform fails, the core returns raw content with `transform: { provider: "none", reason: "failed" }` and a structured transform error such as `transform_provider_failed`, `extract_invalid_json`, or `extract_schema_invalid`. Because summary is the default output, this setup is first-run-critical and must be documented prominently in the tool description and `docs/`.

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

Flow: authorize (PKCE S256, request-bound signed consent token) → approve (single-use code, stored as `sha256(code)`) → token (verify PKCE, issue **ES256 JWT** access token signed by `OAUTH_SIGNING_PRIVATE_JWK`, aud=resource; rotating refresh tokens stored as `sha256(raw)`, grouped by family; replay revokes the family). Auth-code TTL is 300 s, access TTL 600 s, and refresh TTL 30 days. Hosted production requires `OAUTH_CONSENT_SIGNING_SECRET` + `OAUTH_SIGNING_PRIVATE_JWK` (fail-fast at boot).

Scopes: `fetch:read` (default), `fetch:transform` (to use the Transform stage). Tool handlers enforce required scope per request: raw fetch requires `fetch:read`; summary/extract/transform use requires `fetch:transform`.

## Security controls (see threat-model.md)

- OUTBOUND rebinding-proof `guardedFetch`: scheme `http|https` only; reject raw CRLF; reject userinfo-bearing URLs and strip credentials from all sanitized URL values; resolve → `isPrivate` CIDR (v4 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16 incl. metadata, 0.0.0.0/8, 100.64/10, 224/4; v6 ::1, fe80/10, fc00/7, ff00/8, `::ffff:0:0/96`, NAT64 `64:ff9b::`, IPv4-compatible) → connect to the resolved IP (`node:https` with `servername`/`Host` = original host); manual redirects re-validated each hop (`maxHops=5`); decompressed-byte cap; `AbortController` timeout.
- INBOUND: SDK transport Host/Origin DNS-rebinding protection.
- TIER-3 in-browser SSRF: `page.route` guards every browser request; document/script/fetch/XHR/stylesheet requests are fulfilled only through `FetcherPort`; image/font/media/analytics URLs are P1 URL/DNS private-IP checked and aborted; websocket-close; SW off; downloads blocked; render-byte cap (advisory truncation); browser in a separate process/container with no env — in-process launch keeps the OS sandbox ON (`chromiumSandbox` default true), and the hosted path uses a CDP sidecar container (`CAPTATUM_BROWSER_CDP_ENDPOINT`) where `--no-sandbox` is acceptable (container-isolated). The browser never runs in-process with `--no-sandbox` against the gateway.
- Response guards: reject `Content-Length` > max before reading; stream through a counting `TransformStream`.
- Logging: allow-list only (tier, finalUrl, platform, status, bytes, timing, blockReason); never body, never `Set-Cookie`/`Authorization`; canonicalize logged URLs to scheme+host when host is private. Per-call audit event.
- Per-host throttle + global concurrency cap + in-flight URL dedupe + per-job max-egress-fetch counter.

## Storage

OAuth state only (auth codes + refresh tokens, hashed), behind a swappable
`StorePort`:
- **Hosted flavor → TiDB** via `mysql2`, configured with
  `TIDB_HOST/PORT/DATABASE/USER/PASSWORD`. The code ships the TiDB store and
  migrations; provisioning the `smartfetch` database/user/security-group rule is
  deployment work outside this repo slice. No fetched content/body/cache rows are
  stored.
- **SQLite implementation → `node:sqlite`** (file on disk, no server) is shipped
  and tested for local/dev OAuth-state use. The current local stdio bridge has no
  OAuth, so it does not use this store at runtime.

Tables: `oauth_auth_codes` (code hash, client id, subject, redirect URI, resource, scopes JSON, PKCE challenge, expiry), `oauth_refresh_tokens` (token hash, family id, previous token hash, client id, subject, scopes JSON, expiry, consumed timestamp), and `oauth_refresh_token_families` (family id, revoked timestamp). Auth codes are deleted on first consume whether valid or expired. Refresh rotation atomically marks the old token consumed and inserts the next hashed token; replay of a consumed token revokes the whole family. Expiry checks use caller-supplied UTC ISO timestamps. No raw codes/tokens and no fetched content/body/cache rows are stored — the service is stateless otherwise. Schema via SQL migrations (per flavor).

## Contract fixtures

Stable local contract examples live under `test/fixtures/contracts/` and are
checked by `test/contract-fixtures.test.ts`. They use fake/local fetch and
transform seams; they do not require public internet or secrets.

- `raw-safe.json` — `output: "raw"` success. MCP text starts with the provenance
  line and `structuredContent.output` is `"raw"`.
- `summary-fallback.json` — omitted `output` requests the default summary, but
  with no provider configured the shipped behavior falls back to raw content and
  records `transform: { provider: "none", reason: "unconfigured" }`.
- `blocked-ssrf.json` — guarded-fetch rejection still returns a result-shaped
  payload with `code: 0`, `codeText: "FETCH_REJECTED"`, `tier: "error"`, and the
  original guarded-fetch error in `errors[0]`.
- `render-disabled.json` — an empty SPA shell with default `allowRender: false`
  returns `tier: "render-blocked"` and records the skipped render attempt.

The fixture `structuredContent` field locks the **full domain `Result`** record
returned by the use case (not the lean MCP payload above — see "MCP
structuredContent"). Example from `raw-safe.json`:

```json
{
  "schemaVersion": 1,
  "url": "https://fixture.test/contract",
  "finalUrl": "https://fixture.test/contract",
  "tier": 1,
  "output": "raw",
  "resolvedVia": "tier1-meta",
  "platform": { "adapterId": "generic", "label": "Generic HTML", "detectedFrom": "tier1" },
  "jsRequired": false,
  "code": 200,
  "codeText": "OK",
  "result": "Contract Fixture Smart fetch fixture body for contract reconciliation.",
  "timings": { "totalMs": 0, "fetchMs": 0 },
  "errors": []
}
```

## Error shape

All HTTP/JSON-RPC errors:

```
{ "error": { "code": "snake_case", "message": "human text" } }   // HTTP
{ "jsonrpc":"2.0", "error": { "code": -32001, "message": "..." }, "id": null }  // auth-failed JSON-RPC
```

Stable `code` values; `message` may change. Auth failure sets `WWW-Authenticate`.
Tool input validation failures use the same HTTP error wrapper and include
`invalid_input` for malformed tool payloads before any outbound work begins.
Guarded fetch reject codes include `unsupported_scheme`, `invalid_url`,
`crlf_url`, `userinfo_url`, `private_address`, `dns_error`, `dns_empty`,
`redirect_limit`, `max_bytes`, `timeout`, `unsupported_encoding`,
`body_read_error`, `network_error`, and `invalid_options`. Note `max_bytes`
and `extract_schema_invalid` each have two roles: a **hard** guarded-fetch
reject (Tier-1 pre-download) and a **non-fatal advisory** entry inside a
*successful* `Result.errors` (Tier-3 rendered HTML truncated at the cap;
`output: extract` parsed JSON that violated a supported-keyword schema). The
`tier`/`code` distinguish the two — advisory entries never set `tier: "error"`.

## Audit event

One per tool call: `{ occurredAt, subject?, clientId?, tool:"smart_fetch", url_host (scheme+host only), tier, platform, output, status, bytes, durationMs, transformProvider?, transformModel? }`. OAuth transitions also write metadata-only auth events: `{ occurredAt, event, status, clientId?, subject?, resource?, scopes?, redirectHost?, reason? }`. Never includes body, full URL path/query for private hosts, authorization codes, refresh tokens, access tokens, consent tokens, or credentials.

## Deployment

The repo ships two deployment-flavor runtimes off one core engine:
- **Hosted remote server runtime**: Streamable HTTP `/mcp` + gateway OAuth,
  implemented by `src/server.ts` / `src/interfaces/http/*` and exercised locally
  by tests and `pnpm run smoke:hosted`. This repo does **not** ship a public
  hosted deployment, container image, ECS service, or cloudflared route.
- **Self-contained local binary runtime**: the same engine can be compiled (Bun
  `--compile`) into one executable an agent runs locally — no deployment, no
  auth, single-user/single-agent use. (wreq-js native prebuilts bundle
  alongside.) The entrypoint is the stdio bridge
  (`src/interfaces/mcp/stdio-bridge.ts`); under Node the stdio-safe client
  command is `node --no-warnings src/interfaces/mcp/stdio-bridge.ts` (a bare
  process so stdout stays a pure JSON-RPC channel). `pnpm run bridge` must **not**
  be used as the client command — pnpm prints a lifecycle banner to stdout and
  corrupts the protocol stream; use `corepack pnpm --silent run bridge` if a
  package script is required. The binary is built with `pnpm run build:binary`
  (Bun external tool). `build:binary` fails loudly with the exact command to run
  elsewhere when Bun is absent, and never reports success unless the binary was
  actually produced. Local mode still routes every fetch through the same
  guarded-fetch SSRF primitive — "local" is not permission to skip SSRF.

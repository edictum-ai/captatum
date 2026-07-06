# Contracts

Tracks the public and internal contracts for captatum. Update this file **before** changing any tool, port, schema, endpoint, or error shape. v0: fields may be added freely; renaming or removing a field is a breaking change and must be noted here.

## Versioning

Current contract version: `v0`.

### Breaking changes

- **v0.9.0:** (1) `access.gateReason: "login"` is renamed to `"js-required"` — captatum never actually detected login walls; "login" was the catch-all for *render-needed* pages, now labeled honestly. (2) `allowRender` defaults to `true` (hosted auto-renders JS-shell pages; was `false`). A consumer keying on `gateReason === "login"` must switch to `"js-required"`.

## Product

Captatum is the web read an agent can trust: one MCP tool that fetches **any** URL and returns clean, **token-efficient** content plus a **provenance receipt** on every response (tier, final URL, whether JS was required, transform model/tokens) so an agent knows exactly how each result was produced. Every request is **SSRF-guarded**, and fetched content is treated as **untrusted data, never instructions**. The wedge is **trustworthy reads** — clean content from the JS-rendered SPAs and structured pages other tools return empty or blocked.

The **default output is provider-conditional**: `summary` (via the free-model router — OpenRouter/Ollama) when a transform provider is configured (e.g. the hosted server), otherwise `raw` (full clean content, no LLM) — so a zero-config call returns real content instead of silently degrading to a truncated excerpt. `output: "raw"` returns clean resolved content + parsed structured data; `output: "extract"` returns JSON shaped to a caller schema.

Unlike `WebFetch` (static GET + Turndown, which drops `<script>` JSON-LD/app-state and runs no JS) and render-only services (Firecrawl/Jina strip structured data and give no receipt), captatum uses anti-bot TLS-fingerprinted fetch (`wreq-js`), renders JS only when a page needs it, extracts structured data (JSON-LD / Open Graph / meta) from raw HTML, and reports provenance on every response. Anti-bot challenge walls (Cloudflare/Akamai/PerimeterX) over HTTPS it **detects and reports as gated** (`gateReason: captcha`); it does **not** bypass them.

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
  **not** a remote proxy. It reuses the hosted `captatum` use case and tool
  schema unchanged (`src/interfaces/mcp/local-server.ts` builds the same MCP
  server the `POST /mcp` route serves, with single-user local auth). It refuses
  to start under the `hosted` flavor (fails loudly rather than exposing an
  unauthenticated surface), and all logs go to stderr so stdout stays the
  JSON-RPC channel. It does not serve web agents — they require the hosted HTTP
  server.
- Auth is conditional on deployment flavor (see OAuth / Deployment): the hosted flavor requires gateway OAuth bearer tokens; a self-contained local-binary flavor runs without auth.
- Inbound Host/Origin DNS-rebinding protection via the SDK transport (`enableDnsRebindingProtection`, `allowedHosts`, `allowedOrigins`). Hosted boot requires explicit `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS`; local defaults are loopback-only.
- **Discoverability:** the `captatum` tool `description` advertises every output mode (summary/raw/extract), provenance, `allowRender`, and `debug`, and the MCP server sends `instructions` on `initialize` (a capability guide for clients/agents). Both shapes share `createCaptatumMcpServer`, so both expose the same description + instructions. The two-shapes decision (hosted primary, local binary retained) is recorded in `docs/two-shapes.md`.

## Tool: `captatum`

One tool. Input (v0):

| Field | Required | Notes |
| --- | --- | --- |
| `url` | yes | Fully-formed `http`/`https`. `http` upgraded to `https`. No userinfo. |
| `prompt` | no | What the caller wants from the page (drives `summary`/`extract`). Mirrors WebFetch. Defaults to a general summary. |
| `output` | no | `raw` (default with no provider) \| `summary` (default with a provider) \| `extract`. `summary` = token-efficient answer via the Transform router. `raw` = clean resolved content, no LLM. `extract` = structured JSON per `schema`. The default is **provider-conditional**: `summary` when `OPENROUTER_API_KEY`/`OLLAMA_BASE_URL` is set, else `raw`. |
| `schema` | no | JSON schema for `output: extract`. |
| `budget` | no | Max output tokens for `summary`/`extract`. When omitted the server applies a default (`TRANSFORM_MAX_OUTPUT_TOKENS`, default 8000) and clamps any explicit value to the **chosen model's** max output (#125: deepseek-v4-flash 16 384, qwen3.6-flash 65 536 — not a global 4 K ceiling). If the completion still truncates (`finish_reason=length`) after budget escalation, a non-fatal `transform_truncated` advisory is surfaced. |
| `transform` | no | Override the default router/model/provider: `{ model?, provider?, ... }`. |
| `maxBytes` | no | Response byte cap (decompressed). Default 5 MB, server hard-capped. |
| `timeoutMs` | no | Per-tier wall-clock. Default 15 s (Tier-1/2), 20 s (Tier-3). |
| `allowRender` | no | Default **true**. On hosted (browser available) a JS-shell page is rendered automatically; on a no-browser runtime (local) it reports `render-unavailable`. Set `false` to opt out (Tier-3 skipped, provenance reports `render-blocked`). |
| `debug` | no | Default **false**. When true, the MCP `structuredContent` adds heavy diagnostic fields (`attempts`, `timings`, full `structured` incl. JSON-LD `description`/`articleBody`, `redirects`, `durationMs`, `httpContentType`, `contentSha256`, `provenanceHash`, verbose `transform`). Default payload is lean (see "MCP structuredContent"). |

**Default `output` is provider-conditional** — `summary` (resolved content passed through the Transform router: free-first OpenRouter, or local Ollama → a token-efficient answer to `prompt`) when a provider is configured; otherwise `raw` (clean resolved content, no LLM). This is exactly the role WebFetch's Haiku step plays, but cheaper and fed by accurate rendered/extracted content — and a zero-config call with no provider honestly returns full `raw` content instead of silently degrading to a truncated excerpt. Requesting `output: "summary"` explicitly with no provider still falls back to `raw` (`transform.provider: "none"`). Output is MCP `text` with a provenance line as the first line (HTML-comment-wrapped, always model-visible). For `summary`/`extract`, a **deterministic envelope header** (backend-generated, not LLM) follows the provenance line — `contentType`, `title`, `finalUrl`, `access` (public | gated + reason), `images` count + first URL, `transformModel` — so every client (including ones that surface `content` text but not `structuredContent`) sees the key fields; `raw` output omits it. The companion `structuredContent` is a **lean agent payload** (see "MCP structuredContent"), not the full Result — heavy fields are gated behind `debug`. Token-efficiency signals (`bytes`, `contentType`, `transform.inTokens/outTokens`) let the caller follow up.

**Client-aware shaping (#45).** Some connectors render `content[0].text` but not the full `structuredContent` (e.g. Claude Code), so `debug: true` (which places diagnostics in `structuredContent`) appears to do nothing there. The output shape can be tuned per OAuth `client_id` via the `CAPTATUM_CLIENT_PROFILES` env (`clientId=profile,…`; deployment-specific). The `text-forward` profile appends a compact diagnostics block to `content[0].text` when `debug` is on (for non-raw output — raw stays clean); unknown/local `client_id`s get the **default** profile (= today's behavior), so this is additive + backward-compatible. Registered connector `client_id`s are discoverable from the audit log (`audit.tool` events carry `clientId` per call).

## Provenance / Result schema

Extends WebFetch's output shape (`bytes`, `code`, `codeText`, `result`, `durationMs`, `url`) so it's familiar to agents/clients, then adds provenance:

```
Result {
  // WebFetch-compatible core
  url,                        // requested URL
  bytes,                      // fetched content size (bytes)
  code, codeText,             // HTTP status of the final response
  durationMs,                 // total wall-clock
  result,                     // payload the agent consumes: raw content (default, no provider) | summary text (default with provider) | extracted JSON
  // captatum provenance
  schemaVersion: 1,
  finalUrl, redirects: [{ url, status }],
  tier: 1 | 2 | 3 | "none" | "error" | "render-unavailable" | "render-blocked",
  output: "summary" | "raw" | "extract",
  platform: { adapterId, label, detectedFrom },   // adapterId: "generic" (Tier-1) or a platform id e.g. "greenhouse"/"lever"/"ashby" (Tier-2)
  jsRequired: boolean,
  resolvedVia: string,                            // e.g. "tier1-jsonld", "tier1-json", "tier1-text", "tier3-playwright"
  attempts: [{ step, tier, outcome, status?, durationMs, bytes?, reason? }],
  contentType,
  title,                                          // when derivable
  structured: { canonicalUrl?, jsonLd?, og?, meta?, appState?, images? }, // parsed from raw HTML (present when found); images = bounded absolute http(s) image URLs (og:image*, JSON-LD image/ImageObject, <img>/<source srcset>); private/localhost hosts stripped, never fetched by this service
  transform: { provider, model?, free?, inTokens?, outTokens?, latencyMs?, costUsd?, reason?, schemaIssue?, fallbackFrom?, truncated? }, // present on summary/extract or fallback; schemaIssue = non-fatal extract-schema advisory; truncated = the summary was cut at the model's output ceiling after escalation (#125)
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
  contentType: "article" | "job" | "json" | "pin" | "product" | "spa" | "unknown",   // classified from the raw HTTP content-type (json), JSON-LD @type / og:type / host / jsRequired
  result,                              // summary text | raw content | extracted JSON (string)
  tier, code, codeText, bytes,         // kept for existing consumers
  resolvedVia, platform, jsRequired,
  access: { mainContentAccessible, gated, gateReason: "paywall"|"js-required"|"captcha"|"byte_cap"|"http_error"|"none" },
  provenance: { tier, resolvedVia, code, bytes },     // convenience envelope
  warnings: [{ code, message }],       // non-fatal (tier !== "error"): advisories, render-failed-but-tier1-ok, byte-cap truncation, extract_schema_invalid, transform_truncated
  images: ["https://…"],               // bounded absolute http(s) URLs for optional multimodal vision fetch
  errors: [{ code, message }],         // fatal only (tier === "error")
  transform: { provider, model?, free?, inTokens?, outTokens? },   // lean token-efficiency signal; present when a transform ran
}
```

Rules:
- **errors vs warnings:** fatal ⟺ `tier === "error"` (per the note above: "advisory entries never set `tier: error`"). Everything else in `Result.errors` becomes a `warning`.
- **status:** `fail` when `tier === "error"`, the response was 4xx/5xx (the body is an error page, not usable content), or no body content was returned; `partial` when content was returned but warnings exist or the summary/extract transform fell back to raw (`transform.provider === "none"`); else `pass`. A successful candidate-MODEL fallback is a `pass` (not `partial`) — the failed-primary list rides on `transform.fallbackFrom` (debug + audit only), not a warning (#82).
- **access.gateReason:** `paywall` when JSON-LD declares `isAccessibleForFree: false`; `byte_cap` when the response was truncated at the cap; `js-required` when no content was returned on a page that needed JS we could not run (render-blocked/render-unavailable/`jsRequired`); `http_error` when the response was 4xx/5xx (an error page — the body is still returned in `result` for the agent to read the server's message); else `none`.
- **contentType:** `json` when the response's HTTP content-type is `application/json` (or a `+json` suffix); else `pin` for pinterest.*/pin.it hosts; else from the first content-bearing JSON-LD `@type` (`JobPosting`→job, `Product`→product, Article family→article); else `og:type`; else `spa` when `jsRequired`; else `unknown`.
- **images:** never fetched by this service — surfaced for the calling agent's optional vision fetch. Private/loopback hosts are stripped (string check, no DNS).
- **result:** snippeted to ~2000 chars in `structuredContent` when large; the full text is always delivered as MCP `content[0].text` (the primary agent channel), so mirroring a huge body in the structured payload would only duplicate tokens. Summaries are small and pass through unchanged.

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
detector); captcha/challenge pages currently fall to `"js-required"` or `"none"`.

## Ports

- **`FetcherPort`** — the single hardened egress. `fetchGuarded(url, opts, postInit?) → { status, finalUrl, redirects, bodyStream, contentType, bytes } | RejectResult`. Every outbound request (Tier-1, Tier-2 adapter, every redirect hop, every Tier-3 in-browser request) routes through it. The optional `postInit: { method: "POST"; body: Uint8Array; requestContentType?: string }` (#111) carries a first-party POST body on the INITIAL request only — `fetchWithRedirects` reverts to GET + no body on any 3xx (incl. 307/308, a deliberate deviation from RFC 7231) so the body can never reach a redirect target host.
- **`PlatformAdapter`** — `{ id, detect(ctx): DetectResult | null, resolve(input, fetcher): Promise<ResolveResult> }`. Registered in `src/application/adapters.ts`. Optional general-purpose extension point: adding a platform = one folder under `src/infrastructure/<platform>/` + one registry line + one fixture. Not part of the public contract.
- **`StorePort`** — OAuth state only: auth-code records and refresh-token records
  (hashed), plus `close()`. The hosted flavor uses the `node:sqlite` impl
  (`src/infrastructure/sqlite/`, a single file — the DEFAULT) or, when
  `TIDB_HOST` is set, the `mysql2` impl (`src/infrastructure/tidb/`). Selection
  lives in `src/infrastructure/store-selection.ts`. The local stdio bridge has no
  OAuth and opens no store.
- **`ModelRouterPort`** — `pick(task, inputTokens, options?): { provider, model?, free?, reason? }` + `feedback({ model, outcome })` driving sticky per-model health (a model demotes one rank only on SUSTAINED hard failure — ≥3 of the last 5 attempts; transient empties and soft/garbage output don't demote). `options.localOnly` is used for sensitive-content signals so hosted providers are bypassed. Implemented by `src/infrastructure/llm/model-router.ts`.

## Tiers

- **Tier-1 (default).** `wreq-js` fetch (browser TLS/JA3+JA4 fingerprint impersonation → anti-bot) + raw-HTML extraction: JSON-LD `<script application/ld+json>`, Open Graph/twitter meta, canonical, and embedded app state (`__NEXT_DATA__`, `__INITIAL_STATE__`) via a prototype-pollution-safe reviver. Tier-1 egress is still behind `FetcherPort`; direct `wreq-js` calls are not allowed to bypass guarded DNS/IP checks. A **shell-gate** decides whether the page has real content (→ done) or is an empty SPA shell (→ escalate). Generic main-content extraction uses a hand-rolled visible-text extractor that drops DOM a browser would not render (`display:none`, the `hidden` attribute) — but not `visibility:hidden`, which a descendant can override with `visibility:visible` (so dropping its whole subtree would lose genuinely visible content). This keeps config blobs hidden in the markup (e.g. a vscdn career page's `themeOptions`/branding JSON inside `<code style="display:none">`) from being counted as visible content (regression: that ~22KB config dominated `output:raw` and satisfied the shell-gate so Tier-3 never ran). All raw-HTML scanners (element/close-tag, comment, `<style>` display:none class, svg `<text>`) are single-pass linear with a monotonic close-tag search cursor, so an unclosed-same-tag flood within the 5 MB extraction cap cannot stall the synchronous event loop (REDOS-5). The hidden-subtree stripper is a single linear pass with a per-subtree step guard; `output:raw` leads with the content-bearing JSON-LD description (e.g. a `JobPosting` body) when present, visible body text only supplementing it. `defuddle` was **evaluated and not added** — empirical probes against rendered SPAs (Vue/Angular RealWorld, TodoMVC) showed the existing extractor already yields clean main content, and a DOM-parser dependency would expand the untrusted-HTML parse surface without justification (house rule: minimal deps). The `<title>` is derived from JSON-LD when a content-bearing node (JobPosting/Article/…) carries a more specific title than the page `<title>` — fixes embedded-widget/iframe pages whose `<title>` is the host page. When multiple content-bearing JSON-LD nodes are present, the **first in document order wins** (treated as the page's primary content); this is a deliberate heuristic, not a type ranking.
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
- **Tier-2 (optional).** If a registered `PlatformAdapter` detects the URL, it resolves via that platform's public API (clean JSON), short-circuiting extraction/render. Adapters are optional and general. **Shipped: ATS "list all jobs" adapters** (Greenhouse, Lever, Ashby). A career-board URL on an ATS host — a board ROOT such as `boards.greenhouse.io/{token}`, `jobs.lever.co/{site}`, `jobs.ashbyhq.com/{org}`, or the matching list-API hosts (`boards-api.greenhouse.io`, `api.lever.co`, `api.ashbyhq.com`) — is detected from the URL host. A single-job detail URL (`/{token}/jobs/{id}`, `/{site}/{postingId}`, `/{org}/{jobId}`) or a Greenhouse `?gh_jid=` single-job link is intentionally NOT claimed — it falls through to Tier-1 so the specific job's JSON-LD is extracted rather than the whole roster; the board token is extracted from the path and sanitized against a fail-closed slug charset (`[A-Za-z0-9._-]`, ≤128 chars) so a crafted URL cannot steer the request elsewhere; the API URL is rebuilt with `new URL` (host pinned) and fetched **through `FetcherPort`** (rebinding-proof SSRF, byte-capped). Verified list endpoints (no auth, routinely scraped): `boards-api.greenhouse.io/v1/boards/{token}/jobs` (metadata only — descriptions omitted so a 168-role board is ~100KB, not 1.8MB), `api.lever.co/v0/postings/{site}?mode=json` (`mode=markdown` is 406), `api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true`. The response is safe-parsed (prototype-pollution-safe reviver); the INPUT array is capped (cap-then-map) so a large/malicious board cannot pin the event loop normalizing 100k+ jobs, and the output is normalized to a bounded, cross-ATS roster envelope `{platform, board, jobCount, truncated, jobs:[{id,title,url,location,department,team,employmentType,workplaceType,remote,publishedAt,compensation}]}` — full description HTML is dropped (deep-fetch a single JD's `url` at Tier-1, which serves a clean JobPosting JSON-LD), the roster is capped at 500 with a `truncated` flag, and `jobCount` reports the true board size. Field availability is per-ATS: Greenhouse's metadata-only response omits per-job `departments`, so `department` is `null` for Greenhouse (populated for Lever/Ashby); `compensation` is populated for Ashby (`includeCompensation`) and Lever (`salaryRange`/`salaryDescriptionPlain` when present), `null` for Greenhouse; Ashby postings marked `isListed:false` (direct-link-only) are excluded from the roster and the count. Lever API-host list queries preserve the caller's filters (`department`, `team`, `skip`/`limit`, …) while forcing `mode=json`. On no detection, an unknown board (404), a byte-truncated response, or any fetch/parse failure, Tier-2 yields nothing and the request falls through to the generic Tier-1 path — Tier-2 is strictly best-effort and never blocks the generic path. A Tier-2 result carries `tier: 2`, `platform.adapterId` of the ATS (`greenhouse`/`lever`/`ashby`), `resolvedVia: "tier2-<ats>"`, `contentType: "application/json"`, and `bytes` reporting the bytes **fetched from the API** (egress/audit, matching Tier-1 semantics — not the smaller normalized roster size); `output: "raw"` returns the JSON roster, `output: "summary"` summarizes it (a failed/absent summary returns the full roster intact rather than byte-slicing the JSON). Custom-domain career pages that *embed* an ATS board script are recognizable via the adapter's `detect({html})` (the embed-script markers are implemented + unit-tested; wiring that discovery into a post-fetch pass is the follow-up). The single-job Ashby-embed resolver (`?ashby_jid=` on a custom domain → direct Ashby job URL → Tier-1 JSON-LD) is a separate, unaffected path.
- **Tier-3 (core, gated by `allowRender`).** Lazy `import('playwright')`;
  render with hard timeouts + request interception. Every non-aborted GET
  (document/script/fetch/XHR/stylesheet/…) — and a first-party **POST** (fetch/XHR
  only, same registrable domain — #111) — is **fulfilled** through `FetcherPort`
  via `route.fulfill` — the browser never resolves or connects on its own, so the
  DNS-rebinding and redirect TOCTOU that a `route.continue()` guard leaves open
  are impossible, and every redirect hop is re-validated (`maxHops` enforced) by
  the fetcher. Image/font/media/analytics URLs are checked with the same P1
  URL/DNS private-IP guard and then aborted;
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
  domain (e.g. an Ashby board). On hosted these render automatically (`allowRender` defaults true);
  set `allowRender: false` to keep a bare `captatum` from spawning a browser.

## Transform (default output path)

The Transform stage handles `output: summary`/`extract`: resolved content is turned into a token-efficient answer to `prompt` — the role WebFetch's Haiku step plays, but fed by accurate rendered/extracted content and routed through the free-model router so it's cheap. It runs by default only when a provider is configured; otherwise the default is `raw` (no Transform pass).

Modes: `summarize` (default — concise answer to `prompt`, optionally to a token `budget`) and `extract` (structured JSON per `schema`). `output: raw` skips the LLM and returns clean resolved content.

`extract` validates the provider's JSON before returning it. The validator enforces the supported JSON Schema subset used by this tool (`type`, `required`, `properties`, `additionalProperties`, `items`, `enum`/`const`, string length/pattern, numeric bounds, array/property counts, uniqueness, and `allOf`/`anyOf`/`oneOf`/`not`) and fails closed with `extract_schema_invalid` for unsupported validation keywords instead of accepting schema-invalid output. For **supported** keywords, a value mismatch (wrong type, `minLength`, etc.) is **advisory**: the parsed JSON is still returned (imperfect structured data > raw fallback) but the mismatch is surfaced as a non-fatal `extract_schema_invalid` error so the caller is not silently handed schema-violating data.

Provider-configurable via `transform`: **OpenRouter** (default; OpenAI-compatible `chat/completions` over plain `node:https`, key from config) or **local Ollama** (zero egress only when `OLLAMA_BASE_URL` is loopback; a remote HTTPS Ollama is classified as a hosted provider and bypassed for sensitive content). Every provider call carries a bounded `max_tokens`/`num_predict` — the server default when `budget` is omitted, **clamped to the chosen model's max output (#125: deepseek-v4-flash 16 384, qwen3.6-flash 65 536, default 8 000 — replacing the old global 4 000 ceiling that silently truncated heavy doc pages)** — so a missing `budget` cannot trigger unbounded paid generation. If a completion still returns `finish_reason=length`, the router **escalates the budget** (doubling up to the model's max, then falling to a higher-cap candidate) and only if it still truncates surfaces a non-fatal `transform_truncated` advisory — the caller is never silently handed a cut-off answer. The model router enforces a policy hosted routers won't: free-first (`pricing.prompt=="0"`), per-request fit (context length, text modality — filter out audio/coding/image models, JSON-schema support for `extract`), with deterministic **sticky per-model health** (a hard failure — throw / empty / non-2xx / invalid JSON / unsupported schema keyword — pushes into a 5-attempt window; ≥3 hard failures demote one rank, recovering after 2 consecutive successes; soft/garbage output does NOT demote) and a fallback chain: best free → cheap paid (Flash/Haiku) → local Ollama. Provenance records `{provider, model, free, inTokens, outTokens, latencyMs}`. On failure, fall back to raw content + a provenance flag.

Privacy: fetched content is mostly public web content; the only egress risk is non-public content (authed/signed URLs, internal hosts) → detect via signals and route to Ollama or skip.

**Setup & fallback.** Configure `OPENROUTER_API_KEY` (OpenRouter) and/or `OLLAMA_BASE_URL` (local Ollama) in the environment; `OPENROUTER_MODELS` overrides the comma-separated OpenRouter fallback list, `OPENROUTER_BASE_URL` overrides the API base (must be `https://` for any non-loopback host — a non-loopback `http://` base is rejected at boot to prevent cleartext API-key egress), `OLLAMA_MODEL` selects the local model, `TRANSFORM_TIMEOUT_MS` sets provider-call timeouts, and `TRANSFORM_MAX_OUTPUT_TOKENS` sets the default output-token budget applied when `budget` is omitted (default 8000, clamped to the chosen model's max — #125). The router uses whichever is configured (OpenRouter default, Ollama override for sensitive/local). An MCP tool **cannot** see or use the calling agent's own model or credentials, so there is no "use the caller's model" path. **If no transform provider is configured, `output: summary` degrades to `output: raw`** (clean resolved content, no LLM) and provenance records `transform: { provider: "none", reason: "unconfigured" }`. If a configured transform fails, the core returns raw content with `transform: { provider: "none", reason: "failed" }` and a structured transform error such as `transform_provider_failed`, `extract_invalid_json`, `extract_schema_invalid`, or `transform_truncated` (non-fatal — the summary was cut at the model's output ceiling after budget escalation). **The fallback is token-safe:** when the transform did not produce a summary, the returned `result` is bounded to a ~3000-char excerpt with a note (the full page is still available via `output: "raw"`) — a failed summary never dumps the entire page into the agent context. The OpenRouter adapter retries once on an empty/error completion (transient upstream capacity) before the router demotes to the next candidate model, and surfaces OpenRouter's real inline error (top-level `error`, per-choice `error`, `finish_reason`) instead of a generic "empty completion", so the failure reason is visible in `warnings`. **Model fallback is silent on success (#82):** when the primary model (e.g. `deepseek/deepseek-v4-flash`) fails and the router produces the summary with a later candidate, the user-facing receipt is clean — `status` stays `pass`, no warning. The failed-primary list rides on `transform.fallbackFrom` (visible via `debug:true` and the audit log's `transformFallbackFrom`), so the operator still sees flakiness. An all-models-fail still surfaces honestly as `partial` + a `transform_provider_failed` warning. To reduce the prompt size that was failing the primary model on large pages, `articleBody`/`description` are stripped from the JSON-LD fed to the transform (they duplicate the body text already in the input); the body itself is unaffected. The default is **provider-conditional** (`summary` with a provider, `raw` without), so a missing provider no longer silently degrades a default call — it honestly returns `raw` (requesting `summary` explicitly with no provider still falls back to `raw` + the bounded excerpt above).

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

Flow: authorize (PKCE S256, request-bound signed consent token) → approve (single-use code, stored as `sha256(code)`) → token (verify PKCE, issue **ES256 JWT** access token signed by `OAUTH_SIGNING_PRIVATE_JWK`, aud=resource; rotating refresh tokens stored as `sha256(raw)`, grouped by family; replay revokes the family). Auth-code TTL is 300 s, access TTL 600 s, and refresh TTL 30 days. Hosted production requires `OAUTH_CONSENT_SIGNING_SECRET` + `OAUTH_SIGNING_PRIVATE_JWK` + `OAUTH_ISSUER` (an absolute `https` URL) + `OAUTH_RESOURCE` (an absolute URL) — fail-fast at boot, so a missing/malformed issuer or resource fails closed rather than building relative discovery metadata and degrading iss/aud checks to empty string. The Cloudflare Access JWT verifier checks signature/audience/issuer/expiry + email presence in code; the email allowlist (which emails may mint a token) is enforced by the CF Zero Trust Access app policy — the single source of truth — with an optional `CF_ACCESS_EMAIL_ALLOWLIST` env as a defense-in-depth second gate.

Scopes: `fetch:read` (default), `fetch:transform` (to use the Transform stage). Tool handlers enforce required scope per request using the **resolved** output (with the provider-conditional default applied): an effective `raw` call requires `fetch:read`; an effective `summary`/`extract`/transform call requires `fetch:transform`. So a zero-config call with no provider (resolves to `raw`) needs only `fetch:read`.

## Security controls (see threat-model.md)

- OUTBOUND rebinding-proof `guardedFetch`: scheme `http|https` only; reject raw CRLF; reject userinfo-bearing URLs and strip credentials from all sanitized URL values; resolve → `isPrivate` CIDR (v4 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16 incl. metadata, 0.0.0.0/8, 100.64/10, 224/4; v6 ::1, fe80/10, fc00/7, ff00/8, `::ffff:0:0/96`, NAT64 `64:ff9b::`, IPv4-compatible) → connect to the resolved IP (`node:https` with `servername`/`Host` = original host); manual redirects re-validated each hop (`maxHops=5`); decompressed-byte cap; `AbortController` timeout.
- INBOUND: SDK transport Host/Origin DNS-rebinding protection.
- TIER-3 in-browser SSRF: `page.route` intercepts every browser request; **every non-aborted GET — and a first-party POST (same registrable domain, fetch/XHR only — #111) — is fulfilled through `FetcherPort`** (`route.fulfill`, never `route.continue`) so the browser makes no direct egress — connections are IP-pinned and every redirect hop is re-validated (`maxHops`, and a POST's method/body apply to the initial hop only); image/font/media/analytics URLs are P1 URL/DNS private-IP checked and aborted; websocket-close; SW off; downloads blocked; render-byte cap (advisory truncation); browser in a separate process/container with no env — in-process launch keeps the OS sandbox ON (`chromiumSandbox` default true), and the hosted path uses a CDP sidecar container (`CAPTATUM_BROWSER_CDP_ENDPOINT`) where `--no-sandbox` is acceptable (container-isolated). The browser never runs in-process with `--no-sandbox` against the gateway. The first-party POST gate is PSL-aware (`isSameRegistrableDomain` via `psl`), POST-only, header-allowlisted (Content-Type only — never Cookie/Auth/Origin/Referer/Content-Length), body-capped (`CAPTATUM_RENDER_POST_MAX_BYTES`, never truncated) + concurrency-capped (`CAPTATUM_RENDER_POST_CONCURRENCY`), and the body is counted against the essential render-byte pool at dispatch and released on reject so N rejected POSTs cannot blow the pool. A same-registrable cross-origin POST (e.g. a page on developer.atlassian.com POSTing to api.atlassian.com) triggers a Chromium CORS preflight (`OPTIONS`) + a CORS check on the response; captatum synthesizes a permissive first-party preflight response (204 + `Access-Control-Allow-Origin: *` + allow-methods/headers) and adds `Access-Control-Allow-Origin: *` to the forwarded POST response, so the in-render browser admits the cross-origin exchange (captatum is its own controlled fetcher, not a real cross-origin client the upstream must authorize; the POST is already first-party-gated and carries no credentials).
- Response guards: stream through a counting reader that **truncates** at `maxBytes` (advisory `truncated` flag, not a hard reject) — Content-Length is attacker-controlled so a pre-check would only stop honest oversized servers; the streamed cap is the real backstop.
- Logging: allow-list only (tier, finalUrl, platform, status, bytes, timing, blockReason); never body, never `Set-Cookie`/`Authorization`; canonicalize logged URLs to scheme+host when host is private. Per-call audit event.
- Per-host throttle + global concurrency cap + in-flight URL dedupe + per-job max-egress-fetch counter.

## Storage

OAuth state only (auth codes + refresh tokens, hashed), behind a swappable
`StorePort`:
- **Hosted flavor → SQLite (DEFAULT)** via `node:sqlite` — a single file on disk,
  no server. Configured with `CAPTATUM_SQLITE_PATH` (default
  `./data/captatum.sqlite`; the parent dir is created at boot). The hosted flavor
  boots with SQLite when no `TIDB_HOST` is set, so one-click deploys (Railway /
  EC2 / Mac Mini) need no external database. Selection (`chooseStoreBackend`) and
  the TLS gate live in `src/infrastructure/store-selection.ts`.
- **Hosted flavor → TiDB (optional scale path)** via `mysql2`, opted into by
  setting `TIDB_HOST/PORT/DATABASE/USER/PASSWORD` (+ `TIDB_SSL_CA`; TLS required
  regardless of `NODE_ENV`, SQLSTORE-1). The code ships the TiDB store and
  migrations; provisioning the `captatum` database/user/security-group rule is
  deployment work outside this repo slice.
- No fetched content/body/cache rows are stored; the service is stateless
  otherwise.

Tables: `oauth_auth_codes` (code hash, client id, subject, redirect URI, resource, scopes JSON, PKCE challenge, expiry), `oauth_refresh_tokens` (token hash, family id, previous token hash, client id, subject, scopes JSON, expiry, consumed timestamp), and `oauth_refresh_token_families` (family id, revoked timestamp). Auth codes are deleted on first consume whether valid or expired. Refresh rotation atomically marks the old token consumed and inserts the next hashed token; replay of a consumed token revokes the whole family. Consumed refresh tokens are retained until their whole FAMILY is past validity (each rotation issues a fresh TTL, so a successor outlives its consumed predecessor — the consumed row is kept as long as any family member is still valid, so a stolen-token replay can still revoke the family) and then swept; orphaned token families — not only revoked ones — are cleaned once they have no remaining tokens (bounded storage growth, no unbounded accumulator). Expiry checks compare caller-supplied UTC ISO timestamps as strings, so all callers MUST supply UTC ISO 8601 with exactly 3 millisecond digits (`…\.fffZ`); `assertUtcIsoTimestamp` enforces uniform precision — mixed precision would invert lexicographic ordering and flip "expired" into "valid". No raw codes/tokens and no fetched content/body/cache rows are stored — the service is stateless otherwise. Schema via SQL migrations (per flavor).

## Contract fixtures

Stable local contract examples live under `test/fixtures/contracts/` and are
checked by `test/contract-fixtures.test.ts`. They use fake/local fetch and
transform seams; they do not require public internet or secrets.

- `raw-safe.json` — `output: "raw"` success. MCP text starts with the provenance
  line and `structuredContent.output` is `"raw"`.
- `summary-fallback.json` — `output: "summary"` is requested explicitly with no
  provider configured, so the shipped behavior falls back to raw content and
  records `transform: { provider: "none", reason: "unconfigured" }` (the default
  with no provider is `raw`; this fixture pins the explicit-summary fallback path).
- `blocked-ssrf.json` — guarded-fetch rejection still returns a result-shaped
  payload with `code: 0`, `codeText: "FETCH_REJECTED"`, `tier: "error"`, and the
  original guarded-fetch error in `errors[0]`.
- `render-disabled.json` — an empty SPA shell with `allowRender: false` (the opt-out)
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
  "result": "Contract Fixture Captatum fixture body for contract reconciliation.",
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

Admission overload is a distinct, **retryable** JSON-RPC error, separate from `InternalError`. When the hosted server is at concurrent-execution capacity (DOS-2 admission cap) it emits `{ "jsonrpc":"2.0", "id":<id>, "error":{ "code": -32050, "message":"captatum: server overloaded — retry later", "data":{ "retryable": true } } }`. `-32050` is a server-error-range value, reserved and distinct from the auth-failed `-32001`. `data.retryable: true` is the stable contract field. Clients SHOULD treat this as an expected transient condition — back off and retry the same call (ideally with jitter) — NOT as an `InternalError`/bug. The local stdio bridge (single-user, no admission cap) never emits it. There is no `Retry-After` header (Streamable HTTP carries errors inside the JSON-RPC body, not as HTTP 4xx/5xx). (#84)

Stable `code` values; `message` may change. Auth failure sets `WWW-Authenticate` to an RFC 6750 `Bearer` challenge — `Bearer realm="captatum", error="<invalid_token|insufficient_scope>", error_description="<the same actionable text as the JSON-RPC message>"` — so a non-OAuth Streamable HTTP client can read programmatically why its request was rejected. Per RFC 6750 §3 the `error`/`error_description` attributes appear **only when credentials were presented** (a Bearer token that failed verification → `invalid_token`, or a verified token that failed a scope check → `insufficient_scope`); a request with no authentication information (missing or non-Bearer `Authorization`) gets a realm-only challenge, with the actionable remedy carried in the JSON-RPC `message`. Codes outside the RFC 6750 §3.1 set (e.g. `access_denied` at `/oauth/*`) emit realm only. (#104)
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

One per tool call: `{ occurredAt, subject?, clientId?, tool:"captatum", url_host (scheme+host only), tier, platform, output, status, bytes, durationMs, transformProvider?, transformModel? }`. OAuth transitions also write metadata-only auth events: `{ occurredAt, event, status, clientId?, subject?, resource?, scopes?, redirectHost?, reason? }`. Never includes body, full URL path/query for private hosts, authorization codes, refresh tokens, access tokens, consent tokens, or credentials.

## Deployment

The repo ships two deployment-flavor runtimes off one core engine:
- **Hosted remote server runtime**: Streamable HTTP `/mcp` + gateway OAuth,
  implemented by `src/server.ts` / `src/interfaces/http/*` and exercised locally
  by tests and `pnpm run smoke:hosted`. The `.github/workflows/release.yml`
  workflow builds and publishes the gateway and browser-sidecar images to GHCR on
  a `v*` tag (`ghcr.io/edictum-ai/captatum`, `ghcr.io/edictum-ai/captatum-browser`).
  The **gateway image ships no browser binary** — Tier-3 connects to the sidecar
  over CDP (`CAPTATUM_BROWSER_CDP_ENDPOINT`), keeping Chromium out of the gateway's
  blast radius; without a sidecar, Tier-3 is `render-unavailable`. The default
  OAuth-state store is a local SQLite file (no database); self-host templates
  (Railway / EC2 / Mac Mini) live in `deploy/`.
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

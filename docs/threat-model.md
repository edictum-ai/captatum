# Threat Model

Status: v1 threat model for captatum, a URL-fetcher that may also run a
headless browser = textbook SSRF + sandbox surface. Update before any change to
egress, the browser path, or auth. `docs/contracts.md` §"Security controls" is
the contract reference; this file is the security reasoning.

## Assets

- OAuth signing keys and token hashes (hosted flavor only).
- OAuth-state store credentials — the SQLite file path (default backend), or TiDB
  credentials when `TIDB_HOST` is set (hosted flavor only).
- Audit events.
- **Fetched page content is UNTRUSTED DATA, never an asset to protect as
  instructions.** It is treated as hostile text throughout.

## Trust Boundaries

- Browser and agent clients are outside the gateway trust boundary.
- The gateway is the security boundary for scopes and tools.
- The DEFAULT hosted OAuth-state store is a local SQLite file (`node:sqlite`,
  no network) — the OAuth codes/tokens live in a file on the gateway's disk, so
  it has no DB network trust boundary. The optional TiDB scale path (when
  `TIDB_HOST` is set) is reachable only from the captatum task security group on
  `4000/tcp` and reuses an existing MySQL-compatible instance in the private
  infrastructure; its host/account live in the private infra repo, not here.
- The **local-binary flavor has no network trust boundary** — it is single-user /
  single-agent only and runs without auth. It must never be exposed on a network.
  Its entrypoint is the stdio bridge (`src/interfaces/mcp/stdio-bridge.ts`), which
  opens **no network listener** and imports no HTTP server. `assertLocalFlavor`
  makes it fail loudly if pointed at the hosted flavor, so the unauthenticated
  path cannot be re-pointed at a network listener. The reverse is also blocked:
  the HTTP listener path (`src/server.ts` + `createHttpApp`) calls
  `assertHostedFlavor` and **refuses to start under `local-binary`**, so the
  network `/mcp` listener can never be wired to the no-auth local flavor — even
  though `local-binary` is the default when no flavor env is set. Audit/log output goes to
  **stderr** only, keeping stdout as the JSON-RPC channel and avoiding leaking
  metadata into the protocol stream. The local flavor reuses the **same** guarded
  egress primitive as hosted mode — SSRF controls are not relaxed for "local".

## Required Controls

- Authenticate and authorize every `/mcp` request independently (hosted flavor).
  Session IDs are never auth.
- Per-request scope enforcement: `fetch:read` default, `fetch:transform` to use
  the Transform stage.
- Rebinding-proof outbound `guardedFetch` (the single egress primitive):
  - scheme `http|https` only; reject raw CRLF; reject userinfo-bearing URLs and
    keep sanitized URL values credential-free.
  - resolve → exhaustive `isPrivate` CIDR: v4 `10/8`, `172.16/12`, `192.168/16`,
    `127/8`, `169.254/16` (incl. cloud-metadata `169.254.169.254`), `0.0.0.0/8`,
    `100.64/10`, `224/4`; v6 `::1`, `fe80/10`, `fc00/7`, `ff00/8`, IPv4-mapped
    `::ffff:0:0/96`, NAT64 `64:ff9b::`, IPv4-compatible.
  - connect to the **resolved IP** (`node:https` with `servername`/`Host` =
    original host) so DNS cannot rebind post-check.
  - manual redirects re-validated each hop, `maxHops=5`.
  - decompressed-byte cap; `AbortController` timeout.
- Tier-3 in-browser SSRF: `page.route` intercepts every browser request before
  the browser can egress, and **every non-aborted GET — and a first-party POST
  (same registrable domain, fetch/XHR only — #111) — is fulfilled through
  `FetcherPort`** (`route.fulfill`, never `route.continue`) — the browser never
  resolves or connects on its own, so DNS-rebinding and the redirect TOCTOU are
  structurally impossible and every redirect hop is re-validated (`maxHops`).
  Image/font/media URLs and known ad/tracker hosts (`src/domain/adblock.ts`,
  a curated OSS-derived apex list) are checked with the same P1 URL/DNS
  private-IP guard and then aborted — the ad script/pixel never loads, so it can
  inject no DOM and exfiltrate no data, and its URL is stripped from Tier-1
  transform content (less prompt noise, smaller egress). Adblock is THIRD-PARTY
  only: the main-frame navigation and the fetched page's own (sub)domain are
  exempt, so a blocklisted vendor apex that IS the requested page (amplitude.com,
  hotjar.com, …) still loads and its own links survive the strip. WebSockets are closed;
  Service Workers are disabled; downloads are blocked; render-byte cap is
  enforced; the browser runs with an empty environment. **Sandbox model: an
  in-process launch keeps the OS sandbox ON (`chromiumSandbox` defaults true —
  `--no-sandbox` in-process is a release blocker). The hosted path instead runs
  Chromium in a separate sidecar container connected over CDP
  (`CAPTATUM_BROWSER_CDP_ENDPOINT`, `Dockerfile.browser`, `scripts/browser-sidecar.sh`);
  there `--no-sandbox` is acceptable because the container is the isolation
  boundary. The published gateway image (`Dockerfile`) ships **no browser binary**,
  so in-process Tier-3 is structurally impossible there — a misconfigured hosted
  gateway degrades to `render-unavailable` rather than launching Chromium inside the
  OAuth-key blast radius. Blast-radius caveat: the fetcher-fulfillment control above closes the
  page-content SSRF path, but on the current hosted deploy it does not by itself
  fully bound a browser-process compromise — that needs separate network/role
  isolation for the sidecar, tracked as its own infra control. Either way the
  browser never runs in-process with `--no-sandbox` inside the gateway's blast
  radius. The `page.route` SSRF guard applies identically in both modes.**
- Inbound Host/Origin DNS-rebinding protection via the SDK transport
  (`enableDnsRebindingProtection`, `allowedHosts`, `allowedOrigins`). Hosted
  mode fails boot unless `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS` are
  explicit; local mode must stay loopback-only.
- Response guards: reject `Content-Length` > max before reading; stream through a
  counting `TransformStream`.
- Linear HTML extraction (REDOS-5): every element/close-tag/comment/`<style>`/svg-`<text>`
  scanner uses a monotonic close-search cursor (no per-tag rescan to EOS), so an
  unclosed-same-tag flood within the 5 MB `EXTRACT_CHAR_BUDGET` cannot stall the
  synchronous event loop. The byte budget is a backstop, not the primary control; it was
  raised 1 MB → 5 MB so deep-content pages whose article sits late in a large HTML body
  (e.g. Atlassian Jira REST docs, ~2.9 MB with the article at ~2.8 MB) are not beheaded.
- Bounded transform generation: every provider call carries a bounded
  `max_tokens`/`num_predict` — the server default (`TRANSFORM_MAX_OUTPUT_TOKENS`,
  2000) when `budget` is omitted, clamped to a 4000 hard cap — so a missing budget
  cannot trigger unbounded paid generation (cost/latency DoS).
- Logging: metadata-only allow-list (tier, finalUrl, platform, status, bytes,
  timing, blockReason); never body, never `Set-Cookie`/`Authorization`; canonicalize
  logged URLs to scheme+host when host is private.
- Write an audit event for every tool call.
- Treat fetched content as untrusted data — never instructions (prompt-injection
  control).

## Auth Limits

- OAuth is **only** on the hosted flavor. The local-binary flavor has no auth, so
  it must be single-user/single-agent and never exposed on a network.
- Authorization codes and refresh tokens are stored only as `sha256` hashes.
- Refresh-token rotation keeps consumed token hashes so replay can be detected;
  replay revokes the token family and blocks future rotations in that family.
  Retention is bounded but covers the full family validity window: each rotation
  issues a fresh TTL, so a successor outlives its consumed predecessor — a consumed
  row is retained as long as any family member is still valid (so a stolen-token
  replay can still revoke the family), and GC'd only once the whole family is past
  validity. Orphaned families are cleaned, so the store is not a perpetual accumulator.
- Hosted production requires `OAUTH_CONSENT_SIGNING_SECRET` +
  `OAUTH_SIGNING_PRIVATE_JWK` + `OAUTH_ISSUER` (absolute `https` URL) +
  `OAUTH_RESOURCE` (absolute URL), fail-fast at boot. The hosted flavor must not
  silently generate production signing secrets or boot with empty iss/aud;
  missing/malformed injection is a boot failure.
- The Cloudflare Access JWT verifier confirms signature/audience/issuer/expiry and
  email presence in code; identity allowlisting (which emails may mint a token) is
  delegated to the CF Zero Trust Access app policy — the single source of truth.
  `CF_ACCESS_EMAIL_ALLOWLIST` is an optional defense-in-depth second gate.

## Known Risks

- Tier-3 is the maximal SSRF surface. The in-browser controls are mandatory, not
  advisory; a Tier-3 path that drops any of them is a release blocker.
- **TIER3-POST — page-authored upstream egress (#111).** Tier-3 now forwards a
  first-party POST body (Notion/Jira hydrate via POST), which is untrusted page content
  egressed to a first-party endpoint. A compromised/XSSed page on victim.com could amplify
  crafted POST bytes (up to `CAPTATUM_RENDER_POST_MAX_BYTES` × `CAPTATUM_RENDER_POST_CONCURRENCY`
  permits × concurrent renders) to its own origin's side-effecting/CSRF endpoints. Bounded by:
  the registrable-domain first-party gate (`isSameRegistrableDomain`, PSL-aware via `psl`);
  POST-only (`PUT`/`PATCH`/`DELETE` abort); the header allowlist (only `Content-Type` is
  forwarded — never `Cookie`/`Authorization`/`Origin`/`Referer`/`Content-Length`); the per-POST
  body cap (never truncated); the essential render-byte pool accounting (body reserved at
  dispatch, released on reject); and the per-render POST semaphore. The fetcher still
  SSRF-validates the target IP per hop; the body is bytes on a guard-pinned connection.
- **PSL data lag (#111).** Multi-tenant suffix recognition depends on the pinned `psl`
  release's data. A multi-tenant suffix added to the upstream Public Suffix List after the
  pinned release is not yet recognized, so two tenants on that suffix would be treated as the
  same registrable domain (cross-tenant POST egress within the suffix). Mitigated by: pinning
  `psl` to a 15-day-cleared release bumped in routine refresh; the fetcher SSRF guard still
  validates the target IP per hop; no credentials are forwarded; scope is bounded to one
  registrable domain regardless. `localhost`/IP-literal pages never match (fail-closed).
- The Transform router egresses fetched content to OpenRouter. This is acceptable
  for **public** pages. **Non-public content** (authed/signed URLs, internal hosts)
  must route to local Ollama or skip the transform; detection is signal-based, not
  a guarantee. This is the primary data-direction risk. See "Sensitive-content
  detection" below for what is and isn't caught.
- The default `output` is **provider-conditional**: `raw` when no transform provider
  is configured, `summary` when one is. So a missing provider no longer silently
  degrades a default summary into a truncated raw excerpt — the default is honestly
  `raw` (full content, `transform` omitted). Requesting `output: "summary"`
  explicitly with no provider still degrades to `raw` with
  `transform: { provider: "none" }` (a bounded excerpt, not the full page).
- Advisory-only SSRF is unacceptable for the hosted flavor. Every egress path —
  Tier-1, Tier-2, every redirect hop, every Tier-3 document/script/fetch/XHR/
  stylesheet request — must route through enforced `guardedFetch`/`page.route`
  controls, and aborted Tier-3 body types must still pass P1 URL/DNS private-IP
  checks before being aborted.
- Current Tier-1 HTTPS egress intentionally falls back to the Node requester
  instead of `wreq-js` so checked-IP connect semantics can preserve original-host
  SNI and certificate verification. This keeps SSRF controls intact but means the
  `wreq-js` TLS/JA3+JA4 anti-bot benefit is only active for plain HTTP until an
  HTTPS checked-IP + original TLS identity path is proven.
- Single-node store: the default SQLite file (and single-node TiDB) is not HA.
  SQLite suits single-instance / small-team hosted deploys; select TiDB for scale.
- TiDB transaction lifecycle (availability): the pooled-connection transaction
  (`getConnection` → `beginTransaction` → commit/rollback → `release`) releases its
  connection on every exit path including a `beginTransaction` failure, so the small
  (`connectionLimit:5`) pool cannot be exhausted by a handful of begin errors and
  stall every OAuth store operation (auth outage via pool exhaustion).
- OpenRouter API-key egress is `https://`-only: a non-loopback `http://`
  `OPENROUTER_BASE_URL` is rejected at provider construction (and the transport
  refuses an authorization header over cleartext http to a non-loopback host), so a
  misconfigured base URL cannot leak the key in plaintext.

## Sensitive-content detection

`detectSensitiveTransformInput` (`src/infrastructure/llm/safety.ts`) gates whether
fetched content may egress to a hosted LLM (OpenRouter) vs. routing to a
loopback-only provider or skipping the transform. `localOnly` selects only
candidates whose base URL resolves to loopback (`localhost` / `127.0.0.0/8` / `::1`);
a remote HTTPS `OLLAMA_BASE_URL` yields `local:false`, so flagged content falls back
to raw rather than egressing to it — the "stays local" guarantee is loopback-derived
from the actual URL, not from the provider name. It is a signal-based heuristic, not
a guarantee.

High-confidence signals (still flagged — in the source url AND embedded in content):
- Credential values — PEM private-key headers, GitHub/Anthropic/OpenAI/AWS/Slack/
  GitLab tokens, AWS access-key IDs (`AKIA…`), Google API keys (`AIza…`), JWTs, and
  cloud env-var secret assignments (`AWS_SECRET_ACCESS_KEY=…`, `AWS_SESSION_TOKEN=…`,
  `AZURE_CLIENT_SECRET=…`) matched as `NAME=value` (not a generic "secret=" word,
  which false-positived on pages that merely discuss security).
- Header dumps — `Authorization: Bearer/Basic …` and `Set-Cookie:`, matched
  case-insensitively. Embedded URLs are normalized for HTML-escaped separators
  (`&amp;`/`&#38;`/`&#x26;` → `&`) before the credential-key check.
- Internal hosts — `.local`/`.internal`/`.corp`/`.localhost`/`.priv` suffixes and
  private/reserved IP literals (`isPrivate`, incl. cloud-metadata `169.254.169.254`).
- URL-embedded credentials — query params that make a url itself a credential,
  matched on the source url AND any url embedded in content: cloud presigned
  signatures (`x-amz-signature`/`x-amz-credential`/`x-amz-security-token`,
  `x-goog-signature`), Azure Blob SAS (`sig`), generic/Alibaba JWS (`signature`),
  Tencent COS (`q-signature`), and OAuth/API tokens (`access_token`, `api_key`).

Deliberately NOT flagged (the #44 regression: news pages such as `estadao.com.br`
were mis-flagged, which skipped the transform and silently dumped raw):
- Generic ad/CDN keys (`token`, `key`, `auth`, `expires`) in content-embedded urls —
  ad/CDN trackers abuse these and they are not credentials. The SOURCE url still
  checks all keys (these included): fetching a tokenized url is itself suspicious.
  (`sig`/`signature`/`access_token` are real credentials and stay flagged in content
  — an early #44 draft over-narrowed this; corrected after adversarial review.)
- No path-segment "opaque token" heuristic — it was removed (the second #44
  regression). No length/alphabet rule can reliably separate a real opaque token
  from a long news-article slug (`brasil-japao-ao-vivo-copa-do-mundo-2026-06-29`)
  or a CDN hash, so it caused deterministic false-positives on public articles
  (the source URL is scanned, and the article's own slug matched). Real
  path-embedded credentials are still caught: JWTs by the credential-value
  patterns, presigned URLs by the query-key check, internal hosts by
  internalHostReason. The lost coverage (a non-JWT opaque share-token in a URL
  path) is rare and low-risk (fetching a share URL is user-intentional).
- Large content — there is no longer a fail-closed `content_exceeds_scan_cap`. The
  credential/header patterns scan the FULL content; only the embedded-url scan is
  capped at the first 500 KB (ReDoS/DoS hygiene).

Residual risk: a cloud-presigned URL embedded past the 500 KB scan head could egress
to a hosted LLM. Accepted: such a URL on a genuinely public page is low-likelihood,
and a caller who fetches a presigned SOURCE url is still blocked at the source check.

## Implementation Gates

- No egress or browser-path change without updating this doc.
- No dependency install before `docs/dependency-ledger.md` recheck (15-day rule).
  `pnpm audit --prod` must be clean before public hosted deployment, or any
  finding must be documented in the ledger with why no eligible patched version
  can be selected under the 15-day gate.
- The SSRF fixture suite must all be blocked before the hosted flavor ships:
  `169.254.169.254`, `::ffff:169.254.169.254`, `localhost`, `gopher://`, `file://`,
  `302 → 127.0.0.1`, and a DNS-rebind stub. The fixture list is
  `test/fixtures/security/ssrf-payloads.json`, exercised by
  `test/ssrf-fixtures.test.ts` (Tier-1 guard). The Tier-3 in-browser path has its
  own REAL-Chromium regression — a rebinding subresource, a redirect-to-private
  navigation, and a normal-render sanity — in `test/integration/tier3-ssrf.test.ts`,
  which drives a real Chromium through the fetcher-fulfillment path and asserts the
  browser makes no direct egress.
- No public hosted deployment before `OAUTH_SIGNING_PRIVATE_JWK` injection, the
  TiDB OAuth migration/provisioning, explicit `MCP_ALLOWED_HOSTS` /
  `MCP_ALLOWED_ORIGINS`, and authenticated client compatibility tests pass.
- No Tier-3 default-on: `allowRender` must default to **false** so a bare
  `captatum` never spawns a browser.

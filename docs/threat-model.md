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
  the browser can egress, and **every non-aborted GET is fulfilled through
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
- Hosted production requires `OAUTH_CONSENT_SIGNING_SECRET` +
  `OAUTH_SIGNING_PRIVATE_JWK`, fail-fast at boot. The hosted flavor must not
  silently generate production signing secrets; missing injection is a boot
  failure.

## Known Risks

- Tier-3 is the maximal SSRF surface. The in-browser controls are mandatory, not
  advisory; a Tier-3 path that drops any of them is a release blocker.
- The Transform router egresses fetched content to OpenRouter. This is acceptable
  for **public** pages. **Non-public content** (authed/signed URLs, internal hosts)
  must route to local Ollama or skip the transform; detection is signal-based, not
  a guarantee. This is the primary data-direction risk. See "Sensitive-content
  detection" below for what is and isn't caught.
- If no transform provider is configured, `output: summary` degrades to
  `output: raw` and provenance records `transform: { provider: "none" }`. Because
  summary is the default output, misconfiguration silently changes behavior.
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

## Sensitive-content detection

`detectSensitiveTransformInput` (`src/infrastructure/llm/safety.ts`) gates whether
fetched content may egress to a hosted LLM (OpenRouter) vs. routing local-only
(Ollama) or skipping the transform. It is a signal-based heuristic, not a guarantee.

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
- Path-segment token heuristic — only segments ≥40 chars that are letter-rich
  (mixed base64url alphabet) are treated as opaque tokens (JWT-in-path, share-id,
  presigned signature). Pure-hex segments (md5/sha1/sha256 asset hashes) and
  pure-decimal segments (DB/catalog IDs) are rejected, so hashes/IDs do not
  false-positive.
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

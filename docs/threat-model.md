# Threat Model

Status: v1 threat model for smart-fetch, a URL-fetcher that may also run a
headless browser = textbook SSRF + sandbox surface. Update before any change to
egress, the browser path, or auth. `docs/contracts.md` §"Security controls" is
the contract reference; this file is the security reasoning.

## Assets

- OAuth signing keys and token hashes (hosted flavor only).
- TiDB credentials (hosted flavor only).
- Audit events.
- **Fetched page content is UNTRUSTED DATA, never an asset to protect as
  instructions.** It is treated as hostile text throughout.

## Trust Boundaries

- Browser and agent clients are outside the gateway trust boundary.
- The gateway is the security boundary for scopes and tools.
- TiDB is reachable only from the smart-fetch task security group, on `4000/tcp`.
  The hosted flavor reuses an existing MySQL-compatible (TiDB) instance
  provisioned in the private infrastructure — no new database server. The
  specific host/account live in the private infra repo, not this public repo.
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
  Image/font/media/analytics URLs are checked with the same P1 URL/DNS
  private-IP guard and then aborted. WebSockets are closed;
  Service Workers are disabled; downloads are blocked; render-byte cap is
  enforced; the browser runs with an empty environment. **Sandbox model: an
  in-process launch keeps the OS sandbox ON (`chromiumSandbox` defaults true —
  `--no-sandbox` in-process is a release blocker). The hosted path instead runs
  Chromium in a separate sidecar container connected over CDP
  (`CAPTATUM_BROWSER_CDP_ENDPOINT`, `Dockerfile.browser`, `scripts/browser-sidecar.sh`);
  there `--no-sandbox` is acceptable because the container is the isolation
  boundary. Blast-radius caveat: the fetcher-fulfillment control above closes the
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
  a guarantee. This is the primary data-direction risk.
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
- Single-node TiDB (hosted flavor) is not HA.

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
  `smart-fetch` never spawns a browser.

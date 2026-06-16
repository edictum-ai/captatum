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
  No new database server — it reuses `personal-memory-infra`'s TiDB at
  `REDACTED_TIDB_HOST:4000`.
- The **local-binary flavor has no network trust boundary** — it is single-user /
  single-agent only and runs without auth. It must never be exposed on a network.

## Required Controls

- Authenticate and authorize every `/mcp` request independently (hosted flavor).
  Session IDs are never auth.
- Per-request scope enforcement: `fetch:read` default, `fetch:transform` to use
  the Transform stage.
- Rebinding-proof outbound `guardedFetch` (the single egress primitive):
  - scheme `http|https` only; reject raw CRLF; strip userinfo.
  - resolve → exhaustive `isPrivate` CIDR: v4 `10/8`, `172.16/12`, `192.168/16`,
    `127/8`, `169.254/16` (incl. cloud-metadata `169.254.169.254`), `0.0.0.0/8`,
    `100.64/10`, `224/4`; v6 `::1`, `fe80/10`, `fc00/7`, `ff00/8`, IPv4-mapped
    `::ffff:0:0/96`, NAT64 `64:ff9b::`, IPv4-compatible.
  - connect to the **resolved IP** (`node:https` with `servername`/`Host` =
    original host) so DNS cannot rebind post-check.
  - manual redirects re-validated each hop, `maxHops=5`.
  - decompressed-byte cap; `AbortController` timeout.
- Tier-3 in-browser SSRF: `page.route` isPrivate on every subresource;
  `page.on('websocket')` → close; Service Workers disabled; downloads blocked;
  render-byte cap; browser in a separate child process with **no env**; OS sandbox
  on, **never `--no-sandbox`**.
- Inbound Host/Origin DNS-rebinding protection via the SDK transport
  (`enableDnsRebindingProtection`, `allowedHosts`, `allowedOrigins`).
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
- Refresh-token replay revokes the token family.
- Hosted production requires `OAUTH_CONSENT_SIGNING_SECRET` +
  `OAUTH_SIGNING_PRIVATE_JWK`, fail-fast at boot. If the signing JWK is not
  injected, restarts generate a new key and invalidate existing access tokens.

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
  Tier-1, Tier-2, every redirect hop, every Tier-3 subresource — must route through
  the enforced `guardedFetch`/`page.route` controls, not a linter.
- Single-node TiDB (hosted flavor) is not HA.

## Implementation Gates

- No egress or browser-path change without updating this doc.
- No dependency install before `docs/dependency-ledger.md` recheck (15-day rule)
  and `pnpm audit --prod` clean.
- The SSRF fixture suite must all be blocked before the hosted flavor ships:
  `169.254.169.254`, `::ffff:169.254.169.254`, `localhost`, `gopher://`, `file://`,
  `302 → 127.0.0.1`, and a DNS-rebind stub.
- No hosted-flavor ship before `OAUTH_SIGNING_PRIVATE_JWK` injection, the TiDB
  OAuth migration, and authenticated client compatibility tests pass.
- No Tier-3 default-on: `allowRender` must default to **false** so a bare
  `smart-fetch` never spawns a browser.

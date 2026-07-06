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
- **`captatum_bulk` fan-out** is bounded per-call by the BulkGuard caps (see the
  "Bulk fan-out (captatum_bulk)" section). The orchestrator composes the single-
  URL use case per seed and **adds no egress path**: SSRF, Tier-3 in-browser, and
  prompt-injection controls are enforced per-seed, unchanged. Amplification is
  fixed at 1 per caller-supplied URL (no discovery/recursion/`depth`).

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

## Bulk fan-out (captatum_bulk)

`captatum_bulk` runs N independent single-URL fetches under hard per-call bounds.
It is a 50× egress-amplification surface, so this section is load-bearing — read
it before any change to the bulk path. Contract reference:
`docs/contracts.md` §"Tool: captatum_bulk".

**Per-seed controls are UNCHANGED.** The orchestrator composes the single-URL
use case per seed; it opens no new egress path. The rebinding-proof `guardedFetch`
SSRF guard, the Tier-3 in-browser `page.route` fulfillment, the
sensitive-content transform gate, and the "fetched content is untrusted data"
rule all apply identically to each seed. A private-IP / redirect-to-private /
loopback seed is blocked per-seed (one `fail` entry, `tier:"error"`,
`FETCH_REJECTED`) — bulk must NEVER widen these.

**Caps mapped to attack classes (cross-domain v1).** v1 is cross-domain (one call
may span N registrable domains), so the per-host caps do double duty — politeness
to a legitimate host AND the directed-DoS bound against a victim:

| Attack class | Bound |
| --- | --- |
| Directed DoS to a victim (count) | `maxPerHostInBulk` (10), **union-keyed on egress hosts** (seed registrable domain ∪ redirect hosts ∪ `finalUrl` ∪ Tier-2-resolved). Pre-egress: truncate each seed domain; post-egress: abort further seeds to a host over the cap (`bulk_per_host_cap`). Honest worst case: a victim is added to the union only after a seed settles, so the per-victim SEED count can reach `maxPerHostInBulk + maxConcurrency - 1` (= 13 seeds; ≤ × `maxHops` REQUESTS) AND the union token bucket can't gate the undiscovered victim, so the first "discovery wave" (≤ `maxConcurrency` = 4 seeds) hits it concurrently (a one-time burst). See "In-flight discovery overshoot" in contracts.md. |
| Directed DoS to a victim (rate) | `maxPerHostInflight` (2, configurable) token-bucket burst + `crawlDelayMs` (1000, 500 floor) refill, keyed on the SEED registrable domain in v1 (the only host known pre-egress — NOT union-keyed). It rate-bounds a victim only when the victim IS a seed domain (direct flood) or a repeating funnel source; a pure cross-domain funnel victim is rate-bounded only by the global `maxConcurrency` (4) semaphore in v1. Union-keyed rate spacing lands with the quarantine hardening. |
| Unbounded crawl | `maxUrls` (50 raw / 10 summary\|extract) total + seed-list-only (no discovery/recursion/`depth`) + per-host count cap. |
| Egress amplification (bandwidth) | `maxGlobalEgressBytes` (100 MB), host-agnostic global sum from `result.bytes`. Worst-case aggregate is ~120 MB (in-flight overshoot ≤ `maxConcurrency × perSeedMaxBytes` = 4 × 5 MB before the post-seed re-check; a PR 2 dispatch-time reservation tightens it). |
| Browser time / OOM | `maxGlobalWallMs` (180 s) — dispatch-level wall in v1 (PR 2 makes it fetch-aborting via the `CaptatumContext.signal`); render-on-bulk is **rejected** in v1 (`bulk_render_not_supported`), so `maxRenderedSeeds` is inactive until render-on-bulk lands. |
| Cost amplification (LLM $) | `maxTransformCostUsd` ($0.50, caller-set + clamped) re-checked after each transform + `perSeedTransformCostUsd` ($0.05) concurrent-overshoot bound + `maxUrls=10` for summary/extract. |

**Union-keyed per-host gate (defeats redirect/Tier-2 host-evasion).** A directed
attack can spread seeds across N distinct domains that all 302→`victim.com`; keyed
on the seed host these pass trivially. The per-host inflight + count caps are
therefore keyed on the UNION of egress hosts, computed as each seed settles. This
is the cross-domain directed-DoS control.

**Egress-byte accounting honesty (v1).** `maxGlobalEgressBytes` is summed from
`result.bytes` (document bytes) — exact for the raw-default Tier-1 path. v1
structurally rejects `allowRender:true` on bulk (BULK-3), so no renders occur and
there is no Tier-3 subresource byte path to undercount. The deep `egressBytes`
plumbing (subresource bytes → `Result.egressBytes`) lands together with
render-on-bulk so the byte cap stays honest on the render path.

**No cross-seed content concatenation.** Per-seed transform isolation is a
contract invariant: one LLM call per seed, never N bodies in one prompt (forbids
any batch-summary mode in v1).

**Consumer-side prompt-injection amplification (Nx dose).** N entries in one tool
result is an inherent Nx injection-dose amplification — a malicious page in seed
A cannot reach seed B's transform, but the consuming AGENT reads all N results in
one context. Mitigations: a server-generated random fence token (never echoable
from page content) frames each entry; per-entry `contentSha256` is an anti-tamper
handle; the server instructions state bulk entries are untrusted data and the
agent must not act on instruction-shaped text across entries. Inherent residual
risk: an agent that executes instructions found in any fetched page is
vulnerable; bulk raises the dose, not the per-page risk.

**Admission accounting.** The bulk call acquires exactly ONE admission slot
(`MAX_CONCURRENT_MCP=8`); the orchestrator holds the UNWRAPPED executor, so
per-seed fan-out takes no slots and `OverloadedError` (`-32050`) fires only at the
bulk-call boundary (retryable, whole-call), never swallowed as a per-seed error.

**Audit.** Per-seed events (one per seed, `tool:"captatum_bulk"` + `bulkId` +
`url_host`/tier/bytes/transform cost; body allow-list unchanged) + one summary
event (totals + `capBreaches`). Spend and SSRF traceability preserved per seed.

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
- **Deployment egress — the datacenter-ASN wall.** A hosted deployment on a cloud
  datacenter IP (AWS/GCP/Azure) loses to a plain residential webfetch on Cloudflare/anti-bot-
  protected sites (Notion, cppreference, npmjs, Cursor): those sites challenge/slow
  **datacenter ASNs**, so captatum's fetch/render fails (`captcha`, `render_empty`, error
  boundary). captatum's TLS fingerprint is HTTP-only (HTTPS has no fingerprint), and the
  challenge is upstream of the fingerprint anyway — the lever is the **egress IP**, a
  deployment property, not captatum code. captatum renders these same sites correctly from a
  residential IP (verified, same Chromium). Mitigated by: deploy on a **residential-IP host**
  (always-on Mac mini / home server) behind a Cloudflare Tunnel — the egress is residential
  and not challenged; the `FetcherPort` SSRF guard is unchanged. Full analysis + evidence +
  trade-offs: [`docs/deployment-egress.md`](deployment-egress.md); deploy guide:
  [`deploy/mac-mini.md`](../deploy/mac-mini.md).
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

- **`captatum_bulk` — no cross-bulk state in v1 (BULK-1).** There is no per-tenant
  `BulkQuotaPort` and no separate `bulk:read` scope in v1 (founder decision 7), so
  the per-call BulkGuard caps are the ONLY amplification bound. A determined tenant
  can loop bulk calls up to the per-call caps, bounded only by admission concurrency
  (8 slots) and their own rate. The local-binary flavor is single-user / unbounded
  by design. Per-tenant rolling seed-window quota (`BulkQuotaPort`, TTL-aware
  reservations, fail-closed on store error) is a v1 follow-up; it introduces a new
  failure surface (store outage → bulk refused, fail-closed).
- **`captatum_bulk` — no GLOBAL fetch cap across concurrent bulks in v1 (BULK-2).**
  v1 bounds fetches inside the orchestrator (`maxConcurrency=4` per call + union-
  keyed per-host gate) but has no process-wide fetch semaphore shared across
  concurrent bulk calls. 8 concurrent bulks × 4 = up to 32 concurrent fetches,
  exceeding the 2 vCPU / 4 GiB admission sizing. **Therefore hosted bulk ships
  BEHIND `CAPTATUM_BULK_ENABLED` (default OFF) until a global fetch-concurrency
  cap (`LimitingFetcher`) + `BulkQuotaPort` land and OOM/admission behavior is
  monitored.** Local flavor ships ON (single-user; a user saturating their own
  machine is their own concern, and per-call caps bound each call).
- **`captatum_bulk` — Tier-3 fan-out + the render-path union gap (BULK-3).** The
  per-host union gate keys on a seed's seed/redirect/finalUrl hosts. On a Tier-3
  render, the browser also egresses script/xhr/fetch **subresources** through
  `fetchGuarded`, and those hosts never reach the orchestrator's union accounting.
  A malicious seed that rendered could therefore direct many small subresource
  requests at a victim the union never sees — a render-path directed-DoS the
  `maxPerHostInBulk`/`maxPerHostInflight` caps would NOT bind. **v1 structurally
  closes this by REJECTING `allowRender:true` on bulk** (`bulk_render_not_supported`,
  a tool-level input-validation reject) — not merely defaulting it false. Render-on-
  bulk lands only WITH the render-egress-host union plumbing (subresource hosts fed
  into the per-host gate) + deep `egressBytes`. `maxRenderedSeeds` is thus inactive
  in v1 (zero renders) and activates with that plumbing.
- **`captatum_bulk` — directed-DoS to a victim is inherent (BULK-4).** Any bulk
  fetch tool can be aimed at a victim host; the per-host count + rate caps bound
  but do not eliminate it. Residual: captatum's egress IPs could be blacklisted by
  an aggressive victim, degrading service for all tenants. Mitigated by polite
  defaults (low concurrency + crawl-delay + per-host gate) and the founder's
  caller-authorizes-ToS stance (captatum is a targeted agent fetcher, not an open
  crawler). robots.txt respect is deferred to the future `captatum_crawl`.
- **`captatum_bulk` — render-subresource egress undercount (BULK-5).** v1 sums
  `result.bytes` (document bytes) against `maxGlobalEgressBytes`. This is exact for
  the raw-default Tier-1 path; Tier-3 subresource bytes would be undercounted — but
  v1 rejects `allowRender:true` on bulk (BULK-3), so no renders occur and the
  undercount is dormant. It re-activates when render-on-bulk lands alongside the
  deep `egressBytes` plumbing (subresource bytes → `Result.egressBytes`).

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
  **Loopback content exemption (#127):** a loopback host (`localhost`/`127.0.0.0/8`/`::1`)
  *embedded in fetched content* is NOT flagged — a README/docs setup example resolves to the
  reader's machine, not a leaked internal endpoint. The exemption is **content-only** (a loopback
  SOURCE url is still flagged — captatum never fetches a loopback target) and **plain-loopback-only**:
  it does not apply when the URL carries a credential anywhere (query key, fragment key, or
  userinfo `user:pass@`), so a loopback OAuth redirect (`…#access_token=…`,
  `http://client:secret@localhost…`) is still flagged.
- URL-embedded credentials — a url that is itself a credential, matched on the source url AND
  any url embedded in content, in all three locations: QUERY params (cloud presigned signatures
  `x-amz-signature`/`x-amz-credential`/`x-amz-security-token`, `x-goog-signature`, Azure Blob
  SAS `sig`, JWS `signature`, Tencent COS `q-signature`, OAuth/API tokens `access_token`/`api_key`),
  the FRAGMENT (`#access_token=…`, with HTML-escaped `&amp;`/`&#38;`/`&#x26;` separators normalized
  before the key check), and the USERINFO (`user:pass@host`). The fragment + userinfo checks are
  load-bearing for the loopback content exemption — without them a loopback OAuth redirect could
  egress (#127 codex review).

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
- Tier-3 is **shell-gated**, not unconditional: `allowRender` defaults **true**,
  but a render fires only when Tier-1 extraction finds an empty JS shell
  (`jsRequired`) — a normal content-bearing page never spawns a browser. Set
  `allowRender:false` to opt out (`render-blocked`). `captatum_bulk` **rejects
  `allowRender:true`** in v1 (`bulk_render_not_supported`) — the per-host union
  gate does not yet cover Tier-3 subresource egress hosts (BULK-3), so render-on-
  bulk is structurally closed, not merely defaulted false; it lands with the
  render-egress-host union plumbing. The in-process launch keeps the OS sandbox ON
  (`chromiumSandbox` default true); `--no-sandbox` in-process is a release blocker.
  (Cleanup flag: `config.render.allowRenderDefault` is dead — never consumed; the
  live default is `DEFAULT_CAPTATUM_DEFAULTS.allowRender`. Either wire it or drop
  it.)
- **`captatum_bulk` implementation gate (BULK-GATE).** No hosted bulk ship
  (`CAPTATUM_BULK_ENABLED` must stay OFF) until ALL of: (a) BulkGuard unit tests
  prove each cap short-circuits (incl. the union-keyed per-host gate on a
  redirect-funnel fixture); (b) an SSRF bulk fixture (50 seeds: private IPs +
  redirects-to-private + legitimate) asserts ZERO private-IP egress — every
  private seed is a per-seed `FETCH_REJECTED`, never a fetched body; (c) a
  cross-domain directed-DoS fixture (seeds on N distinct domains all 302→victim)
  asserting the union-keyed count cap aborts the overflow; (d) a Tier-3 bulk
  regression asserting every render subrequest routes through `route.fulfill` /
  `fetchGuarded` AND `maxRenderedSeeds` short-circuits (N/A in v1 — bulk rejects
  `allowRender:true`, so zero renders: the regression is the reject itself); (e) a
  global fetch-concurrency cap (`LimitingFetcher`) + per-tenant `BulkQuotaPort`
  have landed; (f) a REAL 50-URL run (not a synthetic green fixture) verifying
  egress-byte accounting and wall-clock against the 2 vCPU / 4 GiB sizing (the
  cerebralvalley render-byte-budget lesson). **v1 status (PR 2):** (a)–(d) + (f)
  pass — the local flavor ships ON; (b) drives the REAL `GuardedHttpFetcher`
  through the orchestrator (`test/bulk-ssrf.test.ts`); (f) ran via
  `src/dev/bulk-probe.ts` (49 real URLs → 7.88 MB egress, ~79–111 s wall, under
  the 100 MB / 180 s caps; per-host cap truncated a 13-seed host to 10). (e)
  (`LimitingFetcher` + `BulkQuotaPort`) remains the hosted-enablement gate — PR 3.
  **Funnel bound (quarantine):** once a REDIRECT-discovered victim (a host in a seed's
  union that is NOT its own seed domain) crosses `maxPerHostInBulk`, the orchestrator
  QUARANTINES — it stops dispatching the remaining seeds (a one-time global pause on
  further dispatch; in-flight seeds finish). This bounds the per-victim SEED count at
  `maxPerHostInBulk + maxConcurrency` (= 14 at the defaults) worst case: a redirect-
  discovery wave can be up to `maxConcurrency` wide (the victim is undiscovered until the
  first funnel seed settles, by which time up to `maxConcurrency` are in flight). Pure-
  direct floods are tighter (`maxPerHostInBulk` via shaping + the pre-egress seed-domain
  check); pure-redirect ≈ `maxPerHostInBulk + maxConcurrency - 1`. Tightening the mix case
  to `+ maxConcurrency - 1` would require quarantining on ANY host reaching the cap
  (including direct), which over-truncates legitimate multi-host bulks — not worth the UX
  cost for one fewer seed at the victim. The per-victim REQUEST count is the seed count ×
  `maxHops` (victim-controlled redirects). A legitimate cross-domain bulk where each seed
  redirects to a DISTINCT destination is NOT quarantined (no host crosses the cap). Residual
  (BULK-4): directed-DoS to a victim is inherent to any bulk tool — these caps bound it to
  ≤ 14 seeds/call, they do not eliminate it; and the quarantine is intentionally coarse (it
  pauses all further dispatch once any victim is discovered, so innocent seeds in the same
  call may also be aborted — the caller retries them).

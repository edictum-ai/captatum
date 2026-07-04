# Changelog

## [0.9.0] — 2026-07-04

Closes the gap a cross-model benchmark (captatum vs a naive webfetch, 48+ dev pages) found: captatum was losing to a plain fetch on JS-rendered docs and on docs themes whose prose isn't in an `<article>`. Two fixes + a breaking receipt label.

- **feat(render): auto-render JS-shells on hosted + honest `js-required` label** (#105) — `allowRender` now defaults to `true`: on hosted, genuine JS-shell pages (Anthropic, DevDocs, AWS, Apple) render automatically instead of returning an empty shell. The shell-gate (`jsRequired`) is still the arbiter, so SSR/static pages (~80%, the Tier-1 path) never render. Local (no browser) honestly reports `render-unavailable`. `allowRender:false` remains an opt-out (MCP + a new CLI `--no-render` flag). **Breaking:** `access.gateReason:"login"` → `"js-required"` (captatum never detected login walls; "login" was the render-needed catch-all).
- **fix(extract): fall back to `<main>` for docs themes without `<article>`** (#103) — VitePress, GitBook, mdBook, Svelte, HashiCorp docs SSR prose into `<main>` (sidebar in a sibling `<aside>`); captatum now selects `<main>` after `<article>`, returning the docs content instead of nav chrome. `<main>` is a subset of `<body>`, so it never returns more chrome than before.
- **Benchmark:** captatum-0.8.0 vs naive webfetch across 48 dev pages — captatum-wins 44% (app-state/JSON-LD/meta extraction), tie-content 25%, tie-chrome 31% (now mostly closed by these two fixes).

Deferred: Cursor render→error-page false-positive (#106), Mintlify extraction noise, anti-bot walls (PyPI/npmjs.com), `AUTH_JSONRPC_CODE=-32001` collision (#100) + OAuth-non-client UX (#104).

Checks: `pnpm run check` + 426 unit + 50 integration fixture tests green.

## [0.8.0] — 2026-07-04

The model router becomes a **proactive, silent reliability layer**, and admission overload becomes a distinct **retryable** signal. Additive contract surface; no breaks.

- **feat(router): proactive sticky demotion + silent model fallback** (#82) — the EMA "bandit" was dead code (#48-C pinned `order`-primary after it demoted on every transient empty). Now revived as **sticky** per-model health: a model demotes one rank only on **sustained** hard failure (≥3 of the last 5 attempts, recovering after 2 consecutive successes), so transient empties and soft/garbage output do **not** demote (the #48-C jumpiness, fixed). A successful model fallback is now **silent** (`status:"pass"`, no warning) — the failed-primary list rides on `transform.fallbackFrom` (visible via `debug:true` and a new `transformFallbackFrom` audit field). An all-models-fail still surfaces honestly. `ModelScore` → `{ model, outcome }`; the old EMA/scoreFor/scoreTransform deleted.
- **fix(mcp): admission overload is a distinct retryable JSON-RPC error** (#84) — was a generic `InternalError`; now `code:-32050` (server-defined, collision-free vs the SDK enum + captatum's `-32001`) with `data:{retryable:true}`, so a client can back off and retry instead of guessing.
- **docs:** truncation-pointer note clarified (the full text is in `content[0].text`, the canonical MCP channel — not a server cap). #83 closed (its doc half shipped in 0.6.0).

Checks: `pnpm run check` + 424 unit + 50 integration fixture tests green.

## [0.7.0] — 2026-07-04

Receipt trustworthiness: four correctness fixes — three of them stop the provenance receipt from actively lying to the agent. Additive contract surface (new `contentType: "json"` + `resolvedVia: "tier1-json"`/`"tier1-text"`); no breaks.

- **fix(shell-gate): non-HTML short bodies are content, not empty SPA shells** (#92) — a legit plain 404 with a trivial `text/plain` body was reported as a login-gated SPA needing JS render (`contentType: "spa"`, `gateReason: "login"`, `tier: "render-blocked"`). The shell-gate now short-circuits non-HTML bodies (`text/plain`, markdown, JSON, XML, image) to `content-present` before any render escalation, and `extractHtml` returns non-HTML bodies verbatim (no HTML-stripping, whitespace-collapse, or trim).
- **fix(tier1): route non-HTML responses away from the HTML extractor** (#94) — JSON API responses (e.g. `registry.npmjs.org`) were HTML-extracted, fabricating image URLs (`registry.npmjs.org/%22…svg%22`) from JSON string values, mislabeled `contentType: "unknown"`, falsely `resolvedVia: "tier1-html"`. JSON now: raw body verbatim, no fabricated images/structured, `contentType: "json"`, `resolvedVia: "tier1-json"`; text/markdown get `"tier1-text"`. The MCP text formatter omits the provenance comment for all JSON bodies (`application/json` + `+json`) so raw stays parseable.
- **fix(extract): scope raw visible text to the main `<article>`** (#93) — repo/blog/docs pages returned flattened site chrome (GitHub's nav header) with zero README text. `extractVisibleText` now runs on the page's main `<article>` (the README on GitHub, the body on most blogs/docs); the page is pre-cleaned (hidden/script/template/comment stripped) so a hidden or inert article isn't selected. Falls back to the full body when there's no `<article>`.
- **fix(store): self-diagnosing error when the SQLite store dir is unwritable** (#85) — under the hosted image's `USER node` the default `./data/captatum.sqlite` path is root-owned; a cryptic `EACCES` boot crash is now an actionable message naming the resolved dir + the `CAPTATUM_SQLITE_PATH` fix (covers both can't-create and exists-but-unwritable).
- **test:** REDOS-2 ratio guard hardened for CI stability (absolute budget + looser ratio).

Checks: `pnpm run check` + 415 unit + 50 integration fixture tests green.

## [0.6.0] — 2026-07-04

Ships the Tier-1 extraction-fidelity + cerebralvalley render-settle work, the shell-gate fix for client-rendered SPAs, the extraction/transform/hosted-auth hardening bundle, and a ~50-pattern deterministic integration fixture suite (real Chromium) now run in CI. Additive + fixes; no public-contract breaks.

- **feat(mcp): output-choice rule of thumb in server instructions** (#79) — `CAPTATUM_SERVER_INSTRUCTIONS` (sent on `initialize`) now teaches the token-saving default: long-form text → `summary`, structured page → `raw` for the lean extracted fields, specific fields → `extract` with a `schema`. Additive; test-locked.
- **fix(extract): Tier-1 content fidelity** (#67) — `<meta charset>` prescan; expanded app-state harvest (`__PRELOADED_STATE__` / `__APOLLO_STATE__` / `__NUXT_DATA__` / any `application/json` script, proto-pollution-safe keying); CSS `display:none` suppression; CDATA stripping before `JSON.parse`; inline SVG `<text>` harvest.
- **fix(render): content-aware post-networkidle settle** (#68) — the cerebralvalley regression: polls `page.content().length` so `setTimeout`/hydration-injected content is captured instead of snapped too early (settleMs 3000 / minDwellMs 1500 / stableMs 400).
- **fix(render): byte-budget no longer aborts essential scripts/fetches** (#80).
- **fix(extract): trivial JSON-LD no longer satisfies the shell-gate** (#87, #81) — empty / context-only `ld+json` blocks (`[]`, `{}`, `{@context}`) no longer count as usable structured data, so client-rendered SPAs correctly route to Tier-3 render instead of returning empty.
- **fix(extract): named-entities normalization** (#71).
- **fix: address outstanding PR review comments** (#59, #61, #63, #64, #66) (#69).
- **harden(extract / transform / hosted-auth / store)** (#86) — linearized adversarial-markup scanners (DoS-bound; `</script` no longer matches `</scripture>`); default output-token cap; Ollama `local` flag derived from a loopback URL; **refuse a bearer credential over cleartext http to a non-loopback host**; Cloudflare Access `https` + absolute-URL boot gates + optional email allowlist; consent-JTI expiry validation; pooled-connection release on all transaction paths; refresh-token family retention; fixed-precision UTC timestamps; IPv4/IPv6-literal loopback check (closes a `127.attacker.example` bypass); form-feed tag-boundary parser fix; TiDB-safe refresh-token sweep. The cleartext-bearer / CF-Access-https / absolute-`OAUTH_ISSUER` items are fail-fast boot guards on previously insecure-or-late-crashing inputs — noted here, not a contract change.
- **test/ci: deterministic integration fixture suite** (#65–#78, #70) — ~50 extraction/render patterns against real Chromium, run as a CI job.
- **docs: README re-centered on the trustworthy, provenance-carrying read** (#88); `CLAUDE.md` + `package.json` description aligned; stale `v0.4.0` release-version refs in `SECURITY.md`, `README.md`, and `docs/contracts.md` updated to `v0.6.0`.

## [0.5.0] — 2026-07-02

- **feat(cli): one-shot CLI + installable agent skill** — `captatum <url>` fetches + prints + exits (kills the #1 DX cliff: the stdio server silently waiting on stdin). `captatum skill install --target claude|codex` writes a captatum agent skill (SKILL.md / AGENTS.md section) so one command gives the agent a first-class "captatum" skill that knows when/how to fetch. `captatum --help` shows usage. No args → stdio MCP server (unchanged). The bin routes based on argv.
- **refactor(mcp): shared local-deps** — `src/interfaces/mcp/local-deps.ts` extracted (fetcher/extractor/transformer/renderer/clock/audit), side-effect-free, used by both the stdio bridge + the CLI.

## [0.4.1] — 2026-07-02

- **fix(mcp): silence local stdio stderr on boot** — the local-binary stdio bridge wrote an `audit.auth` event + a "ready" line to stderr before answering the MCP `initialize` request. Some clients (notably Claude Code) treat any stderr during the handshake as a fatal server error and refuse to connect (`-32000 Failed to reconnect`). Stderr is now silent on a healthy boot (audit/ready gated behind `CAPTATUM_STDIO_DEBUG=1`); a genuine boot failure still reports to stderr. Local-binary only — the hosted HTTP gateway is unaffected.

## [0.4.0] — 2026-07-01

Ships the ATS list-all-jobs Tier-2 adapters + client-aware shaping to `npx` users, and fixes the release workflow (the GitHub Releases page entry) + stale release-version doc refs.

- **feat(tier2): ATS list-all-jobs adapters** (#42, #58) — a career-board URL on an ATS host (Greenhouse/Lever/Ashby) resolves to a bounded structured roster via the platform's public list API in one call (no HTML crawl, no browser). Coverage moat: a generic fetch of `jobs.lever.co/<site>` returns a JS shell; Captatum returns every role as clean JSON. Detection is URL-host (board roots + exact list-API endpoints); single-job, `?gh_jid=`, `?ashby_jid=`, explicit-port, + non-canonical API URLs fall through to Tier-1. Every egress routes through the rebinding-proof `FetcherPort`; tokens fail-closed sanitized; input capped before normalizing (DoS-safe); roster ≤500.
- **feat(mcp): client-aware shaping** (#45, #59) — config-driven output shaping per OAuth `client_id` (`CAPTATUM_CLIENT_PROFILES`). The `text-forward` profile surfaces a compact diagnostics block in `content[0].text` when `debug` is on — fixes "debug:true does nothing in Claude Code" (debug landed only in `structuredContent`, which Claude Code doesn't render). Default for unknown/local clients = today's shape (additive, backward-compatible).
- **ci(release): create the GitHub Releases page entry** — `release.yml` built images + published npm on every tag but never created the Releases page entry (only v0.2.0 had one); added a `release-entry` job (`gh release create --generate-notes`).
- **docs: refresh release-version references** — the README deploy example (`CAPTATUM_TAG`) and `SECURITY.md` "latest release" line were stale at vv0.2.2; now track the current release.

## [0.3.0] — 2026-07-01

First release shipping the post-0.2.2 safety, anti-bot, extraction, and default-output
work to `npx` users — the npm package was stale at 0.2.2 (the deployed Docker image
already carried these).

- **feat(mcp): provider-conditional output default** (#56) — `summary` when a transform
  provider is configured (e.g. the hosted server), `raw` otherwise (e.g. local with no
  `OPENROUTER_API_KEY`). Retires the local DX cliff where a zero-config `summary` silently
  degraded to a ~3000-char excerpt; a zero-config call now honestly returns full raw
  content. The OAuth scope gate resolves the effective output, so a zero-config `raw` call
  needs only `fetch:read`.
- **fix(extract): Pinterest pin caption** (#54 Half A, #55) — a pin's `SocialMediaPosting`
  JSON-LD `articleBody` (author, follower stats, source text) now surfaces on real pin
  detail pages (`pinterest.*/pin/<id>/`, `pin.it`), without ever letting an embedded social
  post dominate an article/landing/board page. Spoof-safe host allowlist + balanced JSON-LD
  traversal (handles `@graph`, array scripts, co-typed nodes, multi-posting selection).
- **feat(#41 Half A, #50): honest anti-bot detection** — Cloudflare/Akamai/PerimeterX
  challenge walls are detected (status-independent, vendor-specific body/header markers)
  and reported as gated (`gateReason: captcha`, `challengeProvider`) — captatum does NOT
  bypass them. Tool description de-overclaimed accordingly.
- **fix(llm): #48** (#53) — pinned `OPENROUTER_MODELS` order so `deepseek-v4-flash` stays
  primary; an empty completion now retries the fallback (with `fallbackFrom` + a warning)
  instead of demoting the primary.
- **fix(safety): sensitive-detector FP + adblocker** (#46, #47, #49) — public news pages
  no longer mis-flagged "sensitive" (tightened credential-query scan; dropped the
  path-segment slug heuristic; ad/tracker domain blocklist in Tier-3 + URL strip in
  Tier-1; closed an orphaned-credential-param bypass; source-URL JWT scan).
- **ops/docs:** `deploy.sh` reads the running browser-sidecar tag (no stale default);
  README/docs honest-scoped (coverage moat, HTTPS-fingerprint caveat).

## [0.2.2] — 2026-06-26

First **working** npm publish (`npx -y @edictum/captatum`). Compiled `src/` → `dist/`
for the published package (Node 24 refuses to type-strip `.ts` inside `node_modules`,
so 0.2.1's bin failed to start).

- `tsconfig.build.json` (`rewriteRelativeImportExtensions`); `pnpm run build` in the
  release job; `bin/captatum.mjs` runs the compiled bridge.
- npm **Trusted Publishing (OIDC)** — passwordless, provenance-attested, no `NPM_TOKEN`.
- Same engine as 0.2.0/0.2.1 (all the v0.2.x work below).

## [0.2.1] — 2026-06-26  ⚠️ broken (deprecated)

First npm publish via Trusted Publishing, but the bin pointed at the `.ts` entrypoint,
which Node 24 cannot type-strip inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
**Use 0.2.2+.** Fixed in 0.2.2 by shipping compiled `dist/`.

## [0.2.0] — 2026-06-26  (Docker/GHCR only; no npm)

Inaugural release. The v0.2.x arc:

- **fix(extract):** strip `display:none`/`hidden` DOM so hidden config blobs (vscdn/Netflix
  `themeOptions`) don't leak into `output:raw` or satisfy the shell-gate. New single-pass
  O(n) `hidden.ts`. `output:raw` leads with the content-bearing JSON-LD description.
- **feat(store):** SQLite (`node:sqlite`) is the default hosted OAuth-state store (no
  database required); TiDB optional via `TIDB_HOST`. Self-host templates (Railway/EC2/Mac Mini).
- **chore:** brand (Captatum mark + Capture Violet), README rewrite (features → why →
  quickstart → deploy → security → docs), LICENSE/CONTRIBUTING/CoC, CI + release workflows
  (GHCR publish on tag, SHA-pinned actions), minimized gateway Dockerfile (no Chromium —
  Tier-3 via the sidecar over CDP; `render-unavailable` when hosted has no sidecar).
- **feat(mcp):** self-describing — rich tool `description` + server `instructions` on
  `initialize`; both shapes share `createCaptatumMcpServer`. `docs/two-shapes.md` decision
  (keep both, hosted primary).
- **chore(release):** SHA-pin all CI/release actions; node 24.17.0 + playwright 1.61.0 pins
  (CVE-driven); README hardened (provenance rationale, honest HTTPS-fingerprint caveat,
  summary-needs-provider, `fetch:transform` scope warning, comparison table); SECURITY.md;
  scrubbed personal data from CLAUDE.md; purged all smart-fetch references; SQLite-default
  store-availability for deploy.

## [0.0.1] — 2026-06-26  (npm placeholder, deprecated)

One-time bootstrap publish to reserve `@edictum/captatum` and configure npm Trusted
Publishing. **Deprecated — use 0.2.2+.**

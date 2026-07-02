# Changelog

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

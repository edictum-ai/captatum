# Changelog

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

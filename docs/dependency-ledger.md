# Dependency Ledger

Status: Rechecked 2026-06-16 against the npm registry (publish dates verified
via `https://registry.npmjs.org/<pkg>`). Re-check every pin immediately before
any `pnpm install` / image build / deploy. All must clear `minimumReleaseAge:
21600` (15 days) enforced in `pnpm-workspace.yaml`; run `pnpm audit --prod`
after install.

This ledger mirrors the table format of
`personal-memory-gateway/docs/dependency-ledger.md`. smart-fetch is a networked
service (URL fetcher + headless render), so every direct runtime dependency is
justified here.

P10 reconciliation removed two previously direct dependencies that are not imported
by shipped code: `oauth4webapi` and `pino`. OAuth is implemented with `jose` plus
repo code; logging currently uses allow-listed console/stderr JSON records. `pino`
may still appear transitively through Fastify in the lockfile, but it is no longer
a direct dependency.

## Toolchain note: pnpm 10.32.0 via corepack

`packageManager` is pinned to `pnpm@10.32.0`. **pnpm 10.16.0 has a
`minimumReleaseAge` bug** (`ERR_PNPM_MISSING_TIME` — it fails to read the
packument `time` field for transitive deps like `jose`, even though the registry
provides it; verified 2026-06-15). 10.32.0 (also used by the sibling
`spec-reviewer` repo with the same 15-day gate) installs cleanly.

This machine's `pnpm` on `PATH` comes from fnm and is an older/buggy version, so
run pnpm through corepack, which honors the `packageManager` pin:

```bash
corepack prepare pnpm@10.32.0 --activate   # one-time
corepack pnpm install
corepack pnpm run check:syntax && corepack pnpm run check:lines && corepack pnpm run typecheck
```

(Note: `corepack pnpm run check` nests `pnpm run …` which can re-resolve to the
fnm binary; run the three sub-scripts directly as above.)

## Toolchain note: Bun for local-binary packaging (external tool, no npm pin)

The self-contained local binary is produced by `pnpm run build:binary`
(`scripts/build-binary.sh`) using `bun build … --compile`. **Bun is an external
developer tool, not an npm dependency** — no package was added to `package.json`
or the lockfile for packaging, so the 15-day `minimumReleaseAge` gate is not
engaged by this work. The stdio bridge itself runs under the pinned Node 24
toolchain via `node --no-warnings src/interfaces/mcp/stdio-bridge.ts` (the
stdio-safe command; `pnpm run bridge` emits a pnpm banner on stdout and must not
be the client command — use `corepack pnpm --silent run bridge` if a package
script is required); Bun is required only to emit the single-file
artifact. When Bun is absent, the build script exits non-zero with the exact
command to run on a Bun-equipped machine and produces no artifact. If a future
change needs an npm package for packaging, it must be added here and clear the
15-day rule first.

## Direct dependencies, dev dependencies, and runtime pins

| Name | Proposed pin | Release/publish date | Date checked | Source URL | Reason |
| --- | --- | --- | --- | --- | --- |
| Node.js | `24.16.0` | `2026-05-21` | `2026-06-15` | https://nodejs.org/dist/index.json | Runtime target (`engines.node: ">=24"`); matches personal-memory-gateway. Node 24 native TS, no build step. |
| pnpm | `10.32.0` | `2026-03-09T21:50:06.437Z` | `2026-06-15` | https://www.npmjs.com/package/pnpm/v/10.32.0 | Package manager; enforces 15-day `minimumReleaseAge`. 10.32.0 required (10.16.0 has the MISSING_TIME bug — see above). Run via corepack. |
| `@modelcontextprotocol/sdk` | `1.29.0` | `2026-03-30T16:50:42.718Z` | `2026-06-15` | https://www.npmjs.com/package/@modelcontextprotocol/sdk/v/1.29.0 | MCP protocol server + Streamable HTTP transport for the hosted `/mcp` endpoint. |
| `fastify` | `5.8.5` | `2026-04-14T12:07:12.232Z` | `2026-06-15` | https://www.npmjs.com/package/fastify/v/5.8.5 | HTTP server + OAuth callback routing for the hosted flavor. |
| `jose` | `6.2.3` | `2026-04-27T15:23:35.019Z` | `2026-06-15` | https://www.npmjs.com/package/jose/v/6.2.3 | OAuth ES256 JWT sign/verify + JWKS for gateway-owned auth (hosted flavor only). |
| `mysql2` | `3.22.3` | `2026-04-27T02:16:51.908Z` | `2026-06-15` | https://www.npmjs.com/package/mysql2/v/3.22.3 | TiDB-compatible driver for the OAuth-state store in the hosted flavor (reuses personal-memory-infra TiDB). |
| `wreq-js` | `2.3.1` | `2026-05-20T09:13:40.492Z` | `2026-06-15` | https://www.npmjs.com/package/wreq-js/v/2.3.1 | Tier-1 fetch: Rust-powered browser TLS/JA3+JA4 fingerprint impersonation for anti-bot bypass. The one hard ingredient; `fetch()`-compatible with native prebuilts, MIT. |
| `playwright` | `1.60.0` | `2026-05-11T19:09:33.114Z` | `2026-06-16` | https://www.npmjs.com/package/playwright/v/1.60.0 | Tier-3 render adapter, loaded only by lazy `import("playwright")` when `allowRender: true` and shell-gate requires it. Latest `1.61.0` was checked and rejected as too new (`2026-06-15T10:06:22.269Z`). Audit result: failed because of pre-existing `hono` via `@modelcontextprotocol/sdk`; see P9 audit result below. |
| `zod` | `4.4.3` | `2026-05-04T07:06:40.819Z` | `2026-06-15` | https://www.npmjs.com/package/zod/v/4.4.3 | Tool I/O schemas (smart_fetch params, extract schema, provenance). |
| `typescript` | `6.0.3` (exact pin) | `2026-04-16T23:38:27.905Z` | `2026-06-15` | https://www.npmjs.com/package/typescript/v/6.0.3 | Dev typecheck (`tsc --noEmit`). 6.0.3 required for `target: ES2023` + `allowImportingTsExtensions` (matches personal-memory-gateway / spec-reviewer). |
| `@types/node` | `24.12.4` (exact pin) | `2026-05-11T22:25:29.000Z` | `2026-06-15` | https://www.npmjs.com/package/@types/node/v/24.12.4 | Dev Node 24 typings. Pinned exact to avoid floating to `24.13.x` (published 2026-06-04/05/10, past the 15-day cutoff). |

## Gating check

The 15-day gate means a pin is eligible only if published on or before
`2026-06-01` when checked on `2026-06-16`. Pins published after that date must
wait.

Pass (eligible on `2026-06-16`, all published `<= 2026-06-01`):

- Node.js `24.16.0` (`2026-05-21`) — PASS
- pnpm `10.32.0` (`2026-03-09`) — PASS
- `@modelcontextprotocol/sdk@1.29.0` (`2026-03-30`) — PASS
- `fastify@5.8.5` (`2026-04-14`) — PASS
- `jose@6.2.3` (`2026-04-27`) — PASS
- `mysql2@3.22.3` (`2026-04-27`) — PASS
- `wreq-js@2.3.1` (`2026-05-20`) — PASS
- `playwright@1.60.0` (`2026-05-11`) — PASS
- `zod@4.4.3` (`2026-05-04`) — PASS
- `typescript@6.0.3` (`2026-04-16`) — PASS
- `@types/node@24.12.4` (`2026-05-11`) — PASS

Must wait: `playwright@1.61.0` (`2026-06-15`, latest dist-tag during the P9
recheck) and newer pre-releases. Every selected pin clears the 15-day gate.

`typescript` and `@types/node` are **pinned exact** (not ranges) in
`package.json` to keep resolution deterministic under the 15-day gate.

## P9 install and audit result

Install command:

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 COREPACK_HOME=/private/tmp/smart-fetch-corepack \
  PNPM_HOME=/private/tmp/smart-fetch-pnpm corepack pnpm add playwright@1.60.0 --save-exact
```

Result: install succeeded with `playwright@1.60.0`; browser binaries were not
downloaded during dependency install.

Audit command:

```bash
COREPACK_HOME=/private/tmp/smart-fetch-corepack PNPM_HOME=/private/tmp/smart-fetch-pnpm \
  corepack pnpm audit --prod
```

Result on `2026-06-16`: **failed** with 5 advisories against transitive
`hono@4.12.23` through `@modelcontextprotocol/sdk@1.29.0` (1 high, 4 moderate;
patched `hono >=4.12.25`). The patched `hono@4.12.25` was rechecked in the npm
registry and was published `2026-06-09T03:28:50.819Z`, so it does **not** clear
the 15-day rule on `2026-06-16`. No eligible audit-clean override exists yet.
This audit blocker is unrelated to the new `playwright@1.60.0` pin.

## Current package state

This ledger is the source of truth for which versions are allowed into the
lockfile. Do not add a new direct dependency or bump an existing pin without
rechecking it here against the registry and the 15-day rule, and resolving or
documenting any `pnpm audit --prod` finding.

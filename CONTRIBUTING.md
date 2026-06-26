# Contributing to Captatum

Captatum is a security-critical MCP web-fetch tool, so contributions are held to a
high bar: minimal dependencies, contract-first changes, and no shortcuts on the
SSRF/sandbox perimeter. Thanks for helping.

## House rules (non-negotiable)

- **`pnpm` only** — `packageManager` pins `pnpm@10.32.0`; enable it via `corepack`
  (`corepack enable && corepack pnpm install`). `minimumReleaseAge: 21600` (15 days)
  is enforced in `pnpm-workspace.yaml` — recheck every new pin against the rule
  before install.
- **Open-source deps only**, minimal, each justified ("actually needed OR too
  complex/risky to reimplement for security"). No proprietary packages.
- **DDD-lite layering:** `src/domain` ← `src/application` (`ports/` + `use-cases/` +
  `queries/`) ← `src/infrastructure` (adapters behind ports) ← `src/interfaces`
  (http + mcp entrypoints). Domain has no infra imports; application depends on
  ports, not concretes.
- **Node 24 native TS, no build step.** Run with `node --no-warnings src/…`. Imports
  carry `.ts` extensions.
- **250-line file limit**, enforced by `pnpm run check:lines`. Split by
  layer/responsibility.
- **Contract-first.** Update `docs/contracts.md` **before** changing any tool, port,
  schema, or error shape. Networked changes also touch `docs/threat-model.md` and
  `docs/dependency-ledger.md`.
- **Security is the backbone.** This is a URL-fetcher that may run a headless
  browser — a textbook SSRF + sandbox surface. Every egress path routes through the
  single `guardedFetch` primitive; the browser never makes direct egress. See
  `docs/threat-model.md`.
- **CI is sacred.** Don't skip checks, don't use `--no-verify`, don't weaken checks
  to get green.

## Development loop

```sh
corepack pnpm install
corepack pnpm run check       # syntax + 250-line limit + typecheck
node --test test/*.test.ts    # unit suite (no browser/network needed)
corepack pnpm run smoke       # lifecycle smoke (hosted + stdio)
```

Integration tests drive a real Chromium and are gated under `test/integration/`
(`pnpm run test:integration`).

## Before opening a PR

1. `pnpm run check` passes and the unit suite is green.
2. Any new/changed dependency pin is recorded in `docs/dependency-ledger.md` with the
   15-day buffer verified.
3. Contracts/threat-model/ledger updated if the change touches tool I/O, ports,
   egress, the browser path, auth, or deps.
4. Squash history into focused commits; conventional-commit titles
   (`fix(extract): …`, `feat(store): …`, `docs: …`).
5. Flag any bug/security concern you noticed — even outside the PR's scope — in the
  description rather than silently fixing it.

## Reporting a security issue

Please do not open a public issue for security vulnerabilities. See the contact
details on the GitHub profile / repository security tab, or reach out privately.
Treat fetched content as hostile throughout — reports about SSRF, sandbox escape,
auth bypass, or prompt-injection handling are especially welcome.

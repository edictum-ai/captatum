<p align="center">
  <img src="docs/brand/captatum-mark-violet.svg" width="84" height="84" alt="Captatum" />
</p>

<h1 align="center">Captatum</h1>

<p align="center"><strong>Adaptive MCP web-fetch for AI agents — every response is a provenance receipt.</strong></p>

<p align="center"><em>Fetch the web. Keep the receipt.</em></p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-7C5CFC.svg" /></a>
  <a href="https://modelcontextprotocol.io"><img alt="MCP" src="https://img.shields.io/badge/MCP-captatum-9B7CF6.svg" /></a>
  <a href="https://nodejs.org"><img alt="Node 24" src="https://img.shields.io/badge/Node-24-339933.svg" /></a>
  <a href="https://github.com/edictum-ai/captatum/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/edictum-ai/captatum/ci.yml?branch=main&label=CI" /></a>
</p>

One tool, any URL: fetch → render JS only when needed → return **token-efficient** content plus first-class **provenance**. The default output is a concise **summary** via free models; **raw** content and schema-driven **extract** are available on request. It works on JS-rendered pages, gets past anti-bot interstitials, and tells the agent exactly how each result was produced.

Captatum is an [MCP server](https://modelcontextprotocol.io) that gives AI agents a **secure, provenance-aware** web-fetch tool — the governed fetch step of the [Edictum](https://github.com/edictum-ai) ecosystem, and a standalone general-purpose tool.

---

## Features

- **Adaptive 3-tier pipeline** — only does the work each page needs.
  - **Tier 1 (default)** — `wreq-js` anti-bot TLS-fingerprint fetch + raw-HTML structured extraction (JSON-LD, Open Graph, Twitter, meta, canonical, app-state, images). Resolves ~95% of pages with no browser.
  - **Tier 2 (optional)** — platform-adapter short-circuit (e.g. Ashby job boards) for clean JSON.
  - **Tier 3 (gated)** — Playwright Chromium render, loaded lazily, only for empty SPA shells (`jsRequired`). Gated behind `allowRender` (default `false`) so a bare call never spawns a browser.
- **Token-efficient by default** — `output: summary` routes through a free-model router (OpenRouter) or local Ollama; `output: raw` returns clean content with no LLM; `output: extract` returns schema-validated JSON.
- **Provenance first-class** — every response carries `tier`, `finalUrl`, `redirects[]`, `jsRequired`, `platform`, `transform` (model + tokens + cost), and `attempts[]` (what was tried / blocked / succeeded).
- **SSRF-safe egress** — every outbound request (Tier-1, Tier-2, every redirect hop, every Tier-3 browser subresource) routes through one hardened `FetcherPort`: DNS-rebinding-proof (resolve-once → pin-to-IP → revalidate per hop), exhaustive IANA private-IP blocking.
- **Hosted OAuth gateway** — PKCE S256, hash-only token storage, single-use codes, replay-revoking refresh rotation, per-request scope enforcement, audit trail.
- **Prompt-injection control** — fetched content is untrusted data, never instructions (per-call nonce fence + system-prompt boundary).
- **Hidden-config-aware extraction** — DOM a browser wouldn't render (`display:none`/`hidden`) is dropped, so config blobs hidden in the markup never masquerade as page content.

## Why Captatum (vs `WebFetch`)

AI agents need to read the web — job postings, docs, product pages, articles. The built-in `WebFetch` does a static GET + Turndown + LLM summary: no JS execution, no anti-bot, no structured data, and no record of how a result was produced. It fails on SPAs, drops JSON-LD, and can't get past Cloudflare.

Captatum uses anti-bot TLS-fingerprinted fetch, renders JS only when a page needs it, extracts structured data from **raw** HTML, defaults to a token-efficient summary, and reports provenance on every response — so an agent's claim about a URL is backed by a receipt.

## The `captatum` tool

| Parameter | Required | Description |
| --- | --- | --- |
| `url` | yes | `http`/`https` URL (`http` auto-upgraded to `https`, no userinfo). |
| `prompt` | no | What the agent wants (drives `summary`). Defaults to a general summary. |
| `output` | no | `summary` (default) \| `raw` \| `extract`. |
| `schema` | no | JSON Schema for `output: extract`. |
| `budget` | no | Max tokens for the summary. |
| `maxBytes` | no | Response byte cap (default 5 MB). |
| `timeoutMs` | no | Per-tier timeout (default 15s Tier-1/2, 20s Tier-3; server-capped 60s). |
| `allowRender` | no | Default `false`. Enable Tier-3 Playwright render. |
| `debug` | no | Default `false`. Heavy diagnostic fields in `structuredContent`. |

```jsonc
// Summary (default) — token-efficient answer to your prompt
{ "url": "https://example.com/article", "prompt": "Summarize in two sentences" }

// Raw — clean content + structured data, no LLM
{ "url": "https://example.com/docs", "output": "raw" }

// Extract — schema-validated JSON
{ "url": "https://jobs.example.com/123", "output": "extract",
  "schema": { "type": "object", "required": ["title"], "properties": {
    "title": { "type": "string" }, "company": { "type": "string" } } } }
```

## Quick start (local, zero setup)

Captatum runs the **same engine** in two flavors. For local development or a single
agent, use the **local stdio bridge** — no auth, no network listener, no external
services:

```sh
corepack pnpm install                       # pnpm 10.32.0 via corepack
node --no-warnings src/interfaces/mcp/stdio-bridge.ts   # stdio MCP server
```

Connect any stdio MCP client (Claude Code, local ChatGPT desktop, custom agents).
The agent connects locally; no cloud, no OAuth, no exposed ports. Local mode still
routes every fetch through the same SSRF-guarded primitive — "local" is not
permission to skip it.

Verify:

```sh
corepack pnpm run check          # syntax + 250-line limit + typecheck
node --test test/*.test.ts       # unit suite (no browser/network needed)
corepack pnpm run smoke          # lifecycle smoke (hosted + stdio)
```

## Deploy (hosted)

The **hosted flavor** is a Streamable-HTTP MCP server (`POST /mcp`) with gateway
OAuth, reachable from web agents (claude.ai, chatgpt.com).

| | **Local (stdio bridge)** | **Hosted (remote server)** |
| --- | --- | --- |
| **What** | Same engine, in-process over stdio | Network listener (Streamable HTTP `/mcp`) |
| **Auth** | None (single-user, loopback only) | OAuth gateway (PKCE, scopes, audit) |
| **Reachable from** | The local agent only | Web agents (claude.ai, chatgpt.com) |
| **Entry point** | `src/interfaces/mcp/stdio-bridge.ts` | `src/server.ts` |
| **State** | None | SQLite file (default, no DB) or TiDB (scale) |
| **Use case** | Local dev, private/single-user agents | Production, web-connected agents |

The hosted flavor boots with a **local SQLite file** for OAuth state by default —
so self-hosting needs **no database**. Front it with **Cloudflare Access** (required
at boot) and run the browser in a **separate sidecar** container (blast-radius
separation). One-click templates for **Railway, EC2, and Mac Mini** live in
[`deploy/`](./deploy/README.md), all sharing one `docker-compose.yml` and `.env`:

```sh
node --no-warnings scripts/gen-oauth-keys.ts   # print OAuth signing keys → .env
CAPTATUM_TAG=<tag> docker compose -f deploy/docker-compose.yml up -d
```

Docker images (`ghcr.io/edictum-ai/captatum`, `…-browser`) are published by the
release workflow on every tag. See [`deploy/README.md`](./deploy/README.md) for the
full guide (Cloudflare setup, secrets, per-target notes).

## Security model

- **SSRF** — one hardened `FetcherPort` for all egress: DNS-rebinding-proof, per-hop
  redirect revalidation, exhaustive IANA special-use IP blocking.
- **Browser sandbox** — Tier-3 Chromium runs in a separate sidecar container
  (hosted); every browser request is fulfilled through the guarded fetcher, so the
  browser never makes its own egress.
- **Prompt injection** — fetched content is wrapped in a per-call nonce fence and
  treated as untrusted data.
- **OAuth** — PKCE S256, hash-only storage, single-use codes, replay-revoking
  refresh rotation, ES256 access tokens, per-request scope enforcement.

Full reasoning: [`docs/threat-model.md`](./docs/threat-model.md).

## Documentation

- [`docs/contracts.md`](./docs/contracts.md) — the spec (tool I/O, ports, provenance, OAuth, errors)
- [`docs/threat-model.md`](./docs/threat-model.md) — security model
- [`docs/dependency-ledger.md`](./docs/dependency-ledger.md) — dependency pins + supply-chain rationale
- [`docs/architecture.md`](./docs/architecture.md) — adaptive-tier architecture
- [`deploy/`](./deploy/README.md) — self-hosting guide + templates

## Contributing

Contributions are welcome and held to a security-critical bar. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md). By participating you agree to abide by the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE) © Arnold Cartagena. Captatum is part of the
[Edictum](https://github.com/edictum-ai) ecosystem — a runtime trust layer for AI
agents — and works standalone as a general-purpose MCP fetch tool.

---

> **Tool-name note (2026-06-24):** the MCP tool identifier is **`captatum`**
> (renamed from `smart_fetch`). Existing connector configs referencing the old name
> must be re-registered — the rename intentionally breaks them.

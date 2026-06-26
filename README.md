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
  <a href="SECURITY.md"><img alt="security" src="https://img.shields.io/badge/security-policy-7C5CFC.svg" /></a>
</p>

Captatum is one MCP tool that fetches **any** URL, renders JS only when needed, and returns **token-efficient** content plus first-class **provenance** — a receipt describing exactly how each result was produced (tier used, final URL, whether JS rendering was required, transform model/tokens). It's an [MCP server](https://modelcontextprotocol.io) and the governed fetch step of the [Edictum](https://github.com/edictum-ai) ecosystem; it also works standalone.

> **Heads-up before the first call.** The default output is `summary`, which needs a transform provider (`OPENROUTER_API_KEY` or `OLLAMA_BASE_URL`). **Without one, `summary` honestly falls back to `raw`** (`transform.provider: "none"`) — it never silently dumps a huge page. For a **zero-config** first call, use `output: "raw"`. See [Quick start](#quick-start-local-stdio).

---

## Why this matters

Agents increasingly **act on** what they read from the web — a job requirement, a price, a cited fact, a doc snippet. A bare LLM summary of a page is **unverifiable**: you can't tell whether the agent read the real page, hit a paywall, got an anti-bot interstitial, or whether the summary came from stale cached text. Captatum returns not just an answer but a **provenance receipt** — the tier used, the final URL after redirects, whether JS rendering was required (or blocked), the platform detected, and the model + tokens + cost of any summary.

That receipt is what makes a fetch tool **governable**:

- **Trust, not faith.** An agent's claim about a URL is only as good as the evidence behind it. With provenance, a downstream check (human or automated) can verify *how* a result was produced before acting on it — evidence-gated progression, not "the model said so."
- **Failure is visible, not silent.** `tier: render-blocked`, `access.gated`, a `max_bytes` warning, or a `transform_model_fallback` tell the agent a result is partial or degraded — so it can retry, render, or escalate instead of confidently reporting garbage.
- **Cost + egress accounting.** Per-call transform model/tokens/cost and the fetch tier make spend and data-direction (e.g. content egressed to OpenRouter) observable — essential when agents fetch at scale or touch non-public URLs.

This is why Captatum is one adaptive tool that always returns content **and** a receipt: the receipt is the point, not a debug extra. It's also the governed-fetch step of the [Edictum](https://github.com/edictum-ai) ecosystem, where an agent may assert a claim about a URL only if a governed Captatum call produced evidence for it.

---

## Why Captatum

Agents need to read the web — docs, job postings, product pages, articles. The usual options each force a tradeoff. Captatum's wedge is **provenance + SSRF-safe self-host + a free-model default**, not raw scale:

| | JS render | Anti-bot TLS fingerprint | Structured extract | Default output | Provenance receipt | Self-host |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Captatum** | gated `allowRender` | plain-HTTP only¹ | JSON-LD/OG/meta/app-state | token-efficient summary | ✅ every call | ✅ (SQLite, no DB) |
| `WebFetch` (Claude) | ❌ | ❌ | ❌ (Turndown) | Haiku summary | ❌ | — |
| Firecrawl | ✅ | partial | ✅ | markdown/html | partial | commercial |
| Jina Reader | ✅ | partial | light | markdown | ❌ | commercial |

¹ **Honest caveat:** the `wreq-js` browser TLS/JA3+JA4 fingerprint impersonation is active for **plain HTTP only**. HTTPS uses a checked-IP Node path (no fingerprint) to preserve rebinding-proof SSRF — so the fingerprint does **not** bypass Cloudflare/anti-bot over HTTPS today. See [Security: scope and limits](#security-scope-and-limits).

**Not for:** bulk crawling, search, or PDF/office-document parsing. Captatum is a single-URL, provenance-first fetch — not a crawl/search engine.

## Features

- **Adaptive 3-tier pipeline** — only the work each page needs.
  - **Tier 1 (default)** — `wreq-js` anti-bot fetch + raw-HTML structured extraction (JSON-LD, Open Graph, Twitter, meta, canonical, app-state, images). Resolves most pages with no browser.
  - **Tier 2 (optional)** — platform-adapter short-circuit (e.g. Ashby job boards) → clean JSON.
  - **Tier 3 (gated)** — Playwright Chromium render, lazy, only for empty SPA shells. Gated behind `allowRender` (**default `false`**) so a bare call never spawns a browser.
- **Token-efficient by default** — `output: summary` routes through a free-model router (OpenRouter) or local Ollama; `output: raw` returns clean content with no LLM; `output: extract` returns schema-validated JSON.
- **Provenance first-class** — every response carries `tier`, `finalUrl`, `redirects[]`, `jsRequired`, `platform`, a lean `transform` (provider/model/free/in/out tokens), and `attempts[]`.
- **SSRF-safe egress** — every outbound request (Tier-1, Tier-2, every redirect hop, every Tier-3 browser subresource) routes through one hardened `FetcherPort`: DNS-rebinding-proof, exhaustive IANA private-IP blocking.
- **Prompt-injection control** — fetched content is untrusted data, never instructions (per-call nonce fence; applies to `summary`/`extract`).
- **Hidden-config-aware extraction** — DOM a browser wouldn't render (`display:none`, `hidden`) is dropped, so config blobs hidden in markup never masquerade as page content.

## Prerequisites

- **Node.js 24+** (uses `node:sqlite` and native `wreq-js` prebuilts).
- **pnpm 10.32.0+** via corepack (`corepack enable`).

## Quick start (local)

The fastest local path is the published package — one line, no clone, no build (Node 24+):

```sh
npx -y @edictum-ai/captatum        # runs the local stdio MCP server
```

Add it to your MCP client config and you're set (see [Connect your client](#connect-your-client)). No auth, no network listener — the client owns the process; `stdin`/`stdout` are the JSON-RPC channel.

**First call — pick one:**
- **Zero-config:** call with `output: "raw"` (clean content + structured data, no LLM, no key).
- **Default summary:** set `OPENROUTER_API_KEY` (free models available) **or** run [Ollama](https://ollama.com) and set `OLLAMA_BASE_URL`. Without one, `summary` honestly falls back to `raw`.

_From source (development):_ `corepack pnpm install && node --no-warnings src/interfaces/mcp/stdio-bridge.ts`. Build integrity: `corepack pnpm run check` + `node --test test/*.test.ts`.

## Connect your client

**Hosted (recommended for most)** — self-host (see [Deploy](#deploy-hosted)) and point your client at `https://<your-host>/mcp` as a remote Streamable-HTTP MCP server. No local install; reachable from claude.ai / ChatGPT / Cursor. **Scopes:** `fetch:read` (the OAuth default) only allows `output: raw`; the default `summary`/`extract`/`transform` require the **`fetch:transform`** scope — request it in your connector config or the headline feature 403s on the first call. Cloudflare Access guards only `/oauth/authorize`; `/mcp` and `/oauth/token` use the gateway's OAuth bearer tokens (no interactive SSO for MCP clients).

**Local single-user** — add the published package to your MCP client config (Node 24+):

```jsonc
{
  "mcpServers": {
    "captatum": {
      "command": "npx",
      "args": ["-y", "@edictum-ai/captatum"],
      "env": { "OPENROUTER_API_KEY": "sk-or-v1-…" }   // optional; omit for raw-only
    }
  }
}
```

(For Claude Code: `claude mcp add captatum -- npx -y @edictum-ai/captatum`. For a no-cloud-egress setup, swap the env for `OLLAMA_BASE_URL=http://localhost:11434`.)

> The local server has **no auth** — single-user, loopback only; never expose it on a network. It opens **no listener** (stdio only), so it's strictly safer than even a loopback HTTP server.
>
> _From source (dev):_ `{"command":"node","args":["--no-warnings","src/interfaces/mcp/stdio-bridge.ts"]}` — never wrap in `pnpm run bridge` (the pnpm lifecycle banner corrupts the JSON-RPC stream; use `corepack pnpm --silent run bridge` if you need a script).

## The `captatum` tool

| Parameter | Required | Description |
| --- | --- | --- |
| `url` | yes | `http`/`https` URL (`http` auto-upgraded to `https`, no userinfo). |
| `prompt` | no | What the agent wants (drives `summary`). Defaults to a general summary. |
| `output` | no | `summary` (default) \| `raw` \| `extract`. |
| `schema` | no | JSON Schema for `output: extract`. |
| `budget` | no | Max tokens for `summary`. |
| `transform` | no | Override the router: `{ provider?, model? }` (e.g. force local Ollama). |
| `maxBytes` | no | Response byte cap (default 5 MB). |
| `timeoutMs` | no | Per-tier timeout (default 15s Tier-1/2, 20s Tier-3; server-capped 60s). |
| `allowRender` | no | Default `false`. Enable Tier-3 Playwright render (needs a browser available). |
| `debug` | no | Default `false`. Adds heavy diagnostics to `structuredContent` (incl. per-call cost). |

```jsonc
// Zero-config raw — clean content + structured data, no LLM, no key
{ "url": "https://example.com/docs", "output": "raw" }

// Summary (needs OPENROUTER_API_KEY or OLLAMA_BASE_URL)
{ "url": "https://example.com/article", "prompt": "Summarize in two sentences" }

// Extract — schema-validated JSON
{ "url": "https://jobs.example.com/123", "output": "extract",
  "schema": { "type": "object", "required": ["title"], "properties": {
    "title": { "type": "string" }, "company": { "type": "string" } } } }
```

Every response's first text line is a provenance marker (`<!-- captatum tier=1 resolvedVia=… -->`), followed for `summary`/`extract` by a deterministic envelope (`contentType`, `title`, `finalUrl`, `access`, `images`, `transformModel`). The companion `structuredContent` is a **lean** payload (`schemaVersion`, `ok`, `status`, `tier`, `access`, `warnings`, `errors`, lean `transform`); per-call `costUsd`/`latencyMs` and full `attempts`/`timings` are gated behind `debug: true`.

## Deploy (hosted)

The **hosted** shape is a Streamable-HTTP MCP server (`POST /mcp`) with gateway OAuth, reachable from web agents (claude.ai, chatgpt.com). It boots with a **local SQLite file** by default — **no database** — behind **Cloudflare Access** (required at boot), with the browser in a **separate sidecar** container.

| | **Local (stdio)** | **Hosted (remote)** |
| --- | --- | --- |
| **Auth** | None (single-user, loopback) | OAuth gateway (PKCE, scopes, audit) |
| **Reachable from** | One local agent | Web agents (claude.ai, chatgpt.com) |
| **State** | None | SQLite file (default) or TiDB (scale) |

Self-host templates (Railway / EC2 / Mac Mini) share one `docker-compose.yml` + `.env`:

```sh
node --no-warnings scripts/gen-oauth-keys.ts          # print OAuth signing keys → .env
CAPTATUM_TAG=v0.2.0 docker compose -f deploy/docker-compose.yml up -d
```

Required env (see `.env.example`): `CAPTATUM_FLAVOR=hosted`, OAuth signing keys (`gen-oauth-keys.ts`), Cloudflare Access (`CF_ACCESS_*`), `MCP_ALLOWED_HOSTS`/`ORIGINS`, `OAUTH_ISSUER`/`RESOURCE`/`REDIRECT_ALLOWLIST`. Docker images are published to GHCR (`ghcr.io/edictum-ai/captatum`, `…-browser`) by the release workflow on each tag — pin a tag (e.g. `v0.2.0`); `:latest` tracks the newest release. Full guide + troubleshooting: [`deploy/README.md`](./deploy/README.md).

**Supply chain:** dependencies are pinned, held to a 15-day minimum-release-age gate, and `pnpm audit --prod` is required clean before deploy (see [`docs/dependency-ledger.md`](./docs/dependency-ledger.md)); the browser-sidecar base image is pinned by sha256 digest, and CI/release GitHub Actions are pinned by commit SHA.

## Security: scope and limits

Captatum is a URL-fetcher that may run a headless browser — a textbook SSRF + sandbox surface. Honest posture:

- **Holds in both shapes:** rebinding-proof SSRF egress (every request, every redirect hop, every browser subresource routes through `guardedFetch`); fetched content treated as untrusted data.
- **Hosted only:** the OAuth gateway, audit trail, and Cloudflare Access consent gate. The **local binary has no auth** — single-user, loopback, never network-expose it.
- **Known limits (not gaps hidden as features):**
  - Tier-1 HTTPS does **not** use the TLS fingerprint (checked-IP Node path preserves SSRF; see caveat above).
  - The browser sidecar shares the gateway's network namespace; blast-radius separation is process/secret-level, and full browser containment is an open infrastructure control ([`docs/threat-model.md`](./docs/threat-model.md)).
  - Prompt-injection fencing applies to `summary`/`extract`, **not** `output: raw`.
  - Per-host throttle / URL dedupe / render-concurrency caps are implemented; some broader abuse controls remain open.
  - One disclosed residual: a char-class/metachar ReDoS in extract-schema validation (authenticated callers only, low risk) — close with RE2 or a worker timeout.

Full reasoning + the SSRF fixture suite: [`docs/threat-model.md`](./docs/threat-model.md). Report vulnerabilities via [SECURITY.md](./SECURITY.md).

## Documentation

- [`docs/contracts.md`](./docs/contracts.md) — the spec (tool I/O, ports, provenance, OAuth, errors)
- [`docs/threat-model.md`](./docs/threat-model.md) — security model + SSRF fixture suite
- [`docs/dependency-ledger.md`](./docs/dependency-ledger.md) — pins + supply-chain rationale
- [`docs/architecture.md`](./docs/architecture.md) — adaptive-tier architecture
- [`docs/two-shapes.md`](./docs/two-shapes.md) — local vs hosted decision
- [`docs/extraction.md`](./docs/extraction.md) — raw-HTML structured extraction
- [`deploy/`](./deploy/README.md) — self-hosting guide + templates

## Contributing

Contributions are welcome and held to a security-critical bar. See [`CONTRIBUTING.md`](./CONTRIBUTING.md). By participating you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE) © Arnold Cartagena. Captatum is part of the [Edictum](https://github.com/edictum-ai) ecosystem — a runtime trust layer for AI agents — and works standalone as a general-purpose MCP fetch tool.

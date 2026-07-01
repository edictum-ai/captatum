<p align="center">
  <img src="docs/brand/captatum-mark-violet.svg" width="84" height="84" alt="Captatum" />
</p>

<h1 align="center">Captatum</h1>

<p align="center"><strong>Fetch the JS-rendered, structured, and dynamic pages other tools return empty.</strong></p>

<p align="center"><em>Fetch the web. Keep the receipt.</em></p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-7C5CFC.svg" /></a>
  <a href="https://modelcontextprotocol.io"><img alt="MCP" src="https://img.shields.io/badge/MCP-captatum-9B7CF6.svg" /></a>
  <a href="https://nodejs.org"><img alt="Node 24" src="https://img.shields.io/badge/Node-24-339933.svg" /></a>
  <a href="https://github.com/edictum-ai/captatum/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/edictum-ai/captatum/ci.yml?branch=main&label=CI" /></a>
  <a href="SECURITY.md"><img alt="security" src="https://img.shields.io/badge/security-policy-7C5CFC.svg" /></a>
</p>

Captatum is one MCP tool that fetches a URL and returns the **actual content** — including the JS-rendered SPAs, structured data (JSON-LD / Open Graph), and dynamic pages that `WebFetch`, Firecrawl, and Jina return empty or blocked. It renders JS only when a page needs it, extracts structured data from raw HTML, and defaults to the clean raw content (a token-efficient `summary` when a transform provider is configured). Anti-bot challenge walls (Cloudflare/Akamai/PerimeterX) it **detects and reports as gated** rather than silently returning the challenge page — it does not bypass them (see the honest scope below). Every response also carries a **provenance receipt** (tier, final URL, whether JS was required, transform model/tokens) so the agent knows how a result was produced. It's an [MCP server](https://modelcontextprotocol.io); it works standalone and is part of the [Edictum](https://github.com/edictum-ai) ecosystem.

> **Heads-up before the first call.** The default output is **provider-conditional**: `summary` when a transform provider (`OPENROUTER_API_KEY` or `OLLAMA_BASE_URL`) is configured (e.g. the hosted server), otherwise `raw` — the full clean content, no LLM. So a zero-config first call just works (raw); set a provider and it becomes a token-efficient summary. Request `output: "summary"`/`"raw"`/`"extract"` explicitly to override. See [Quick start](#quick-start-local-stdio).

---

## Why Captatum

The wedge is **coverage**: captatum fetches pages other tools can't. `WebFetch` does a static GET + Turndown (it drops `<script>` JSON-LD/app-state and runs no JS); Firecrawl and Jina render but strip structured data and charge at scale. Captatum combines raw-HTML structured extraction, a gated real-browser render, and an HTTP anti-bot fetch (TLS/JA3 fingerprint) — so it returns content where the others return an empty shell. **Anti-bot challenge walls over HTTPS (Cloudflare/Akamai/PerimeterX) it cannot bypass — it detects them and reports `gateReason: captcha` instead of returning the challenge page as content.**

> **Proof — a real client-rendered SPA (`excalidraw.com`):** a plain fetch gets only the shell — `Excalidraw Whiteboard try { function setTheme…` — no app content. Captatum with `allowRender: true` returns the **actual rendered UI**: *"Pick a tool & Start drawing!… Canvas actions 100%… Exit zen mode."* And for a posting on `explore.jobs.netflix.net`, Captatum extracts the full job description from the page's `JobPosting` JSON-LD — the structured data `WebFetch`'s Turndown throws away.

| | JS render | Anti-bot TLS fingerprint | Structured extract | Default output | Provenance receipt | Self-host |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Captatum** | gated `allowRender` | plain-HTTP only¹ | JSON-LD/OG/meta/app-state | token-efficient summary | ✅ every call | ✅ (SQLite, no DB) |
| `WebFetch` (Claude) | ❌ | ❌ | ❌ (Turndown) | Haiku summary | ❌ | — |
| Firecrawl | ✅ | partial | ✅ | markdown/html | partial | commercial |
| Jina Reader | ✅ | partial | light | markdown | ❌ | commercial |

¹ **Honest scope:** the `wreq-js` TLS/JA3+JA4 fingerprint is active for **plain HTTP only**; HTTPS uses a checked-IP Node path (no fingerprint) to preserve rebinding-proof SSRF. So Captatum does **not** bypass Cloudflare/Akamai/PerimeterX challenge walls over HTTPS — instead it **detects them and reports `access.gated` + `gateReason: captcha` + the provider** rather than silently returning the challenge page ([#41](https://github.com/edictum-ai/captatum/issues/41), shipped as honest detection). A browser-bypass was researched and found **not viable** for a self-hosted tool (the datacenter-IP ASN wall + the OSS-stealth treadmill) — see `docs/specs/issue-41-design.md`. See [Security: scope and limits](#security-scope-and-limits).

**Not for:** Captatum is the best tool for the **hard single-URL fetch + structured extract** (a job description, a dynamic doc, a product page). It is *not* a batch crawler at scale, a search engine, or a PDF/office parser — though bounded site fetches (e.g. every job on a career site via the ATS API, [#42](https://github.com/edictum-ai/captatum/issues/42)) are on the roadmap.

## Features

- **Adaptive 3-tier pipeline** — only the work each page needs.
  - **Tier 1 (default)** — `wreq-js` fetch (HTTP TLS/JA3 fingerprint; HTTPS uses the checked-IP Node path — see the honest scope) + raw-HTML structured extraction (JSON-LD, Open Graph, Twitter, meta, canonical, app-state, images). Resolves most pages with no browser.
  - **Tier 2 (optional)** — platform-adapter short-circuit (e.g. Ashby job boards) → clean JSON.
  - **Tier 3 (gated)** — Playwright Chromium render, lazy, only for empty SPA shells. Gated behind `allowRender` (**default `false`**) so a bare call never spawns a browser.
- **Honest default output** — `output: raw` (the default when no transform provider is configured) returns clean content with no LLM; `output: summary` (the default when a provider is configured) routes through a free-model router (OpenRouter) or local Ollama; `output: extract` returns schema-validated JSON.
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
npx -y @edictum/captatum        # runs the local stdio MCP server
```

Add it to your MCP client config and you're set (see [Connect your client](#connect-your-client)). No auth, no network listener — the client owns the process; `stdin`/`stdout` are the JSON-RPC channel.

**First call — pick one:**
- **Zero-config:** just call — the default is `raw` (clean content + structured data, no LLM, no key).
- **Summary by default:** set `OPENROUTER_API_KEY` (free models available) **or** run [Ollama](https://ollama.com) and set `OLLAMA_BASE_URL`; the default then becomes `summary`. You can always pass `output: "summary"`/`"raw"`/`"extract"` explicitly.

_From source (development):_ `corepack pnpm install && node --no-warnings src/interfaces/mcp/stdio-bridge.ts`. Build integrity: `corepack pnpm run check` + `node --test test/*.test.ts`.

## Connect your client

**Hosted (recommended for most)** — self-host (see [Deploy](#deploy-hosted)) and point your client at `https://<your-host>/mcp` as a remote Streamable-HTTP MCP server. No local install; reachable from claude.ai / ChatGPT / Cursor. **Scopes:** `fetch:read` (the OAuth default) only allows `output: raw`; the default `summary`/`extract`/`transform` require the **`fetch:transform`** scope — request it in your connector config or the headline feature 403s on the first call. Cloudflare Access guards only `/oauth/authorize`; `/mcp` and `/oauth/token` use the gateway's OAuth bearer tokens (no interactive SSO for MCP clients).

**Local single-user** — add the published package to your MCP client config (Node 24+):

```jsonc
{
  "mcpServers": {
    "captatum": {
      "command": "npx",
      "args": ["-y", "@edictum/captatum"],
      "env": { "OPENROUTER_API_KEY": "sk-or-v1-…" }   // optional; omit for raw-only
    }
  }
}
```

(For Claude Code: `claude mcp add captatum -- npx -y @edictum/captatum`. For a no-cloud-egress setup, swap the env for `OLLAMA_BASE_URL=http://localhost:11434`.)

> The local server has **no auth** — single-user, loopback only; never expose it on a network. It opens **no listener** (stdio only), so it's strictly safer than even a loopback HTTP server.
>
> _From source (dev):_ `{"command":"node","args":["--no-warnings","src/interfaces/mcp/stdio-bridge.ts"]}` — never wrap in `pnpm run bridge` (the pnpm lifecycle banner corrupts the JSON-RPC stream; use `corepack pnpm --silent run bridge` if you need a script).

## The `captatum` tool

| Parameter | Required | Description |
| --- | --- | --- |
| `url` | yes | `http`/`https` URL (`http` auto-upgraded to `https`, no userinfo). |
| `prompt` | no | What the agent wants (drives `summary`). Defaults to a general summary. |
| `output` | no | `raw` (default with no provider) \| `summary` (default with a provider) \| `extract`. |
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
node --no-warnings scripts/gen-oauth-keys.ts          # print OAuth signing keys → .env (clone the repo — this helper isn't in the npm package)
CAPTATUM_TAG=v0.2.2 docker compose -f deploy/docker-compose.yml up -d
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

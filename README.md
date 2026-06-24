# Captatum

**Adaptive MCP web-fetch for AI agents — every response is a provenance receipt.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-smart__fetch-blue)](https://modelcontextprotocol.io)
[![Node 24](https://img.shields.io/badge/Node-24-green)](https://nodejs.org)

One tool, any URL: fetch → render JS only when needed → return **token-efficient** content plus first-class **provenance**. Default output is a concise **summary** via free models; **raw** content and schema-driven **extract** are available on request.

Captatum is an [MCP server](https://modelcontextprotocol.io) that gives AI agents a **secure, provenance-aware** web-fetch tool.

---

## What is Captatum?

AI agents need to read web pages — job postings, docs, product pages, articles. Existing tools (like Claude's `WebFetch`) do a **static GET + markdown + LLM summary** with no JS, no anti-bot, and no record of how a result was produced. They fail on SPAs, drop structured data, and can't get past Cloudflare.

**Captatum solves this** with an adaptive 3-tier pipeline:

| Tier | What it does | When |
|---|---|---|
| **Tier 1** (default) | `wreq-js` anti-bot TLS-fingerprint fetch + raw-HTML structured extraction (JSON-LD, OG, meta, app-state) | ~95% of pages — anything with real content |
| **Tier 2** (optional) | Platform adapter short-circuit (e.g. Ashby job boards) | When a registered adapter detects the URL |
| **Tier 3** (gated) | Playwright Chromium render → extraction | Only for empty SPA shells (`jsRequired`) |

After acquisition, the **Transform** stage produces the output:
- **`summary`** (default) — token-efficient answer to the agent's `prompt`, via free models (OpenRouter) or local Ollama.
- **`raw`** — clean content + structured data, no LLM.
- **`extract`** — schema-validated JSON per a caller-supplied JSON Schema.

---

## Key Features

- **Anti-bot fetch** — `wreq-js` browser TLS/JA3+JA4 fingerprint impersonation bypasses Cloudflare on HTTP; HTTPS uses a checked-IP fallback with original-host SNI.
- **Lazy JS rendering** — Playwright Chromium loaded only for empty SPA shells. The browser runs in a separate sidecar container (hosted) with every request fulfilled through the SSRF-guarded fetcher.
- **Structured extraction** — JSON-LD, Open Graph, Twitter Card, canonical URL, meta description, `__NEXT_DATA__`, `__INITIAL_STATE__` — all from raw HTML.
- **Provenance first-class** — every response carries `tier`, `finalUrl`, `redirects[]`, `jsRequired`, `platform`, `timings`, `structured`, `transform` (model + tokens + cost), and `attempts[]` (what was tried/blocked/succeeded).
- **SSRF-safe** — every outbound request routes through a single hardened `FetcherPort`: DNS-rebinding-proof (resolve-once → pin-to-IP → revalidate every redirect hop), exhaustive IANA private-IP blocking.
- **OAuth gateway** (hosted) — PKCE S256 mandatory, hash-only token storage, atomic single-use codes, replay-revoking refresh rotation, per-request scope enforcement.
- **Prompt-injection control** — fetched content is untrusted data, never instructions. Per-call nonce fence + system prompt boundary enforcement.
- **Audit trail** — every tool call logged (metadata-only: tier, URL host, platform, status, bytes, transform cost). No body, no tokens.

---

## The `smart_fetch` Tool

| Parameter | Required | Description |
|---|---|---|
| `url` | yes | `http`/`https` URL (`http` auto-upgraded to `https`) |
| `prompt` | no | What the agent wants (drives `summary`). Defaults to general summary. |
| `output` | no | `summary` (default) \| `raw` \| `extract` |
| `schema` | no | JSON Schema for `output: extract` |
| `budget` | no | Max tokens for the summary |
| `maxBytes` | no | Response byte cap (default 5 MB) |
| `timeoutMs` | no | Per-tier timeout (default 15s Tier-1/2, 20s Tier-3; server-capped 60s) |
| `allowRender` | no | Default `false`. Enable Tier-3 Playwright render. |
| `debug` | no | Default `false`. Heavy diagnostic fields in structuredContent. |

### Examples

```json
// Summary (default) — token-efficient answer to your prompt
{ "url": "https://example.com/article", "prompt": "Summarize in two sentences" }

// Raw — clean content + structured data, no LLM
{ "url": "https://example.com/docs", "output": "raw" }

// Extract — schema-validated JSON
{
  "url": "https://jobs.example.com/123",
  "output": "extract",
  "schema": { "type": "object", "required": ["title"], "properties": {
    "title": { "type": "string" }, "company": { "type": "string" }
  }}
}
```

---

## Deployment: Local vs Hosted

Captatum runs in **two flavors** off one core engine. The difference:

| | **Local (stdio bridge)** | **Hosted (remote server)** |
|---|---|---|
| **What it is** | Same engine, runs in-process via stdio | Network listener (Streamable HTTP `/mcp`) |
| **Auth** | None (single-user, loopback only) | Full OAuth gateway (PKCE, scopes, audit) |
| **Reachable from** | The local agent only | Web agents (Claude.ai, ChatGPT.com) |
| **Entry point** | `src/interfaces/mcp/stdio-bridge.ts` | `src/server.ts` |
| **External deps** | None (all in-process) | TiDB, Cloudflare Tunnel, browser sidecar |
| **Use case** | Local development, private agents, single-user tools | Production multi-tenant, web-connected agents |

### Local Mode (zero setup)

```bash
# Install + run — that's it. No auth, no network listener, no external services.
corepack pnpm install
node --no-warnings src/interfaces/mcp/stdio-bridge.ts
```

Works with any MCP client that supports stdio (Claude Code, local ChatGPT desktop, custom agents). The agent connects locally; no cloud, no OAuth, no exposed ports.

### Hosted Mode (production)

The hosted flavor is a **Streamable HTTP MCP server** reachable from web agents (Claude.ai, ChatGPT.com). It requires real infrastructure:

#### Requirements

| Component | Purpose | Notes |
|---|---|---|
| **Node 24 runtime** | Runs the gateway server | Docker image (ARM64 for Fargate) |
| **TiDB (MySQL-compatible)** | OAuth state store (codes, refresh tokens, families) | Any MySQL-compatible DB works; TiDB Cloud is used in production |
| **Cloudflare Tunnel** | Exposes the server publicly without an open inbound port | `cloudflared` container sidecar |
| **Cloudflare Access** | Human authentication gate on `/oauth/*` | Prevents anonymous token minting; the app fails-boot without it configured |
| **Browser sidecar container** | Long-lived Chromium for Tier-3 renders (CDP on `:9222`) | `mcr.microsoft.com/playwright` image; matches the gateway's `playwright` npm pin |
| **Transform provider** | LLM for `summary`/`extract` output | **OpenRouter** (free models, needs API key) or **Ollama** (local, no key — untested in hosted) |
| **Secrets** | OAuth signing JWK, consent secret, OpenRouter key, TiDB password, tunnel token | Injected via AWS Secrets Manager → ECS env vars |

#### What's exposed

- **`POST /mcp`** — the only MCP endpoint (authenticated, per-request bearer token)
- **`GET /healthz`** — health check (returns `{ status: "ok" }`)
- **`/oauth/*`** — OAuth authorize/approve/token/revoke (gated by Cloudflare Access)
- Everything else → 405

No inbound ports are open on the task itself — all traffic flows through the Cloudflare Tunnel. The browser sidecar is loopback-only (CDP on `localhost:9222`).

#### Production architecture (AWS ECS Fargate)

```
                    Cloudflare Tunnel
                    (cloudflared sidecar)
                          │
                    ┌─────┴──────┐
                    │  Captatum  │ ← smart-fetch gateway (Node 24, Fastify)
                    │  gateway   │    OAuth + MCP + transform
                    └─────┬──────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
        ┌─────┴────┐ ┌───┴────┐ ┌───┴──────┐
        │ Browser  │ │  TiDB  │ │ OpenRouter│
        │ sidecar  │ │ (MySQL)│ │  / Ollama │
        │ (CDP)    │ └────────┘ └──────────┘
        └──────────┘
```

One ECS task, three containers (gateway + cloudflared + browser), awsvpc networking. The task role is **permissionless** (secrets injected at start by the execution role; no runtime Secrets Manager access). The browser sidecar runs `--no-sandbox` (container-isolated; the container is the sandbox boundary).

#### Cloudflare setup

1. **Cloudflare Tunnel** — create a tunnel, point it at `http://127.0.0.1:3000` (the gateway's listen port). The `cloudflared` sidecar connects using `TUNNEL_TOKEN`.
2. **Cloudflare Access** — create an application policy on the tunnel's public hostname covering `/oauth/*`. This gates the OAuth flow behind human auth (email/SAML/etc.) so anonymous clients can't mint tokens. The app itself doesn't enforce this in-code (it's defense-in-depth) — the edge does.
3. **DNS** — the tunnel's public hostname (e.g. `smart-fetch.example.com`) resolves through Cloudflare; no direct DNS to the task.

#### Transform provider

The `summary` output (the default) needs an LLM. Two options:

- **OpenRouter** (tested, production) — set `OPENROUTER_API_KEY` + `OPENROUTER_MODELS` (comma-separated primary + fallback). Free models work (`deepseek/deepseek-v4-flash`, `qwen/qwen3.6-flash`). The gateway routes: primary first, fallback on failure, both different labs so a DeepSeek outage doesn't take down the fallback.
- **Ollama** (local, **untested in hosted**) — set `OLLAMA_BASE_URL` + `OLLAMA_MODEL`. No API key needed, fully private. Would need the Ollama server reachable from the gateway (sidecar or network peer).
- **Neither** — `summary` degrades to `raw` with `provider: "none"`. Honest fallback, not silent.

---

## Quick Start (development)

```bash
# Clone + install (pnpm 10.32.0 via corepack)
corepack pnpm install

# Verify
corepack pnpm run check          # syntax + 250-line limit + typecheck

# Smoke test
corepack pnpm run smoke           # lifecycle (hosted + stdio)

# Run the local stdio bridge
node --no-warnings src/interfaces/mcp/stdio-bridge.ts

# Single-URL diagnostic (real pipeline, real Chromium)
PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright" \
  node --no-warnings src/dev/render-probe.ts "https://example.com" [--render]

# URL assertion suite (SSRF guards, Tier-1/3)
node --no-warnings src/dev/url-suite.ts
```

---

## Security Model

- **SSRF**: every outbound request (Tier-1, Tier-2, every Tier-3 browser subresource, every redirect hop) routes through one hardened `FetcherPort`. DNS-rebinding-proof (resolve-once, pin-to-IP, revalidate per hop). Exhaustive IANA special-use IP blocking (RFC 1918, loopback, link-local, benchmarking, documentation, CGNAT, multicast, reserved, 6to4, site-local, NAT64).
- **Browser sandbox**: Tier-3 Chromium runs in a separate container (hosted) or sandboxed process (local). Every browser request is fulfilled through the guarded fetcher — the browser never makes its own egress.
- **Prompt injection**: fetched content is wrapped in a per-call nonce fence and treated as untrusted data. The system prompt enforces "never instructions."
- **OAuth**: PKCE S256, hash-only storage, single-use codes, replay-revoking refresh rotation, ES256 access tokens, per-request scope enforcement, audit trail.

See [`docs/threat-model.md`](docs/threat-model.md) for the full security reasoning.

---

## Documentation

- [`docs/contracts.md`](docs/contracts.md) — the spec (tool I/O, ports, provenance, errors)
- [`docs/threat-model.md`](docs/threat-model.md) — security model (SSRF, sandbox, OAuth)
- [`docs/dependency-ledger.md`](docs/dependency-ledger.md) — dependency pins + supply-chain rationale

---

## Ecosystem

Captatum is part of the [Edictum](https://github.com/edictum-ai) ecosystem — a **runtime trust layer for AI agents**. Captatum is the governed fetch step: the agent may assert a claim about a URL only if a governed Captatum call produced evidence for it. The gate enforces evidence *presence*, not factual *truth*.

Captatum stays **standalone** — it works as a general-purpose MCP tool with or without Edictum.

---

## Status

Hosted deployment live (ECS/Fargate + Cloudflare Tunnel + Cloudflare Access + TiDB), connected to ChatGPT and Claude.ai. MIT licensed.

## Tool Name Note

The product is **Captatum**. The MCP **tool identifier remains `smart_fetch`** (already registered in live ChatGPT/Claude.ai configs — renaming would break those connections).

# Captatum

**Adaptive MCP web-fetch for AI agents — every response is a provenance receipt.**

One tool, any URL: fetch → render JS only when needed → return token-efficient
content plus first-class **provenance** (tier reached, final URL after redirects,
`jsRequired`, structured JSON-LD/OG data, timings). Default output is a concise
summary; raw content and schema-driven extract are available on request.

Captatum is the **acquisition + provenance front-end** for the
[Edictum](https://github.com/edictum-ai) ecosystem: the SSRF-safe, content-aware
way an agent reaches into the web and brings back a citable, attested artifact.

## Why

WebFetch (the Claude built-in) does a static GET + Turndown + Haiku — no JS, no
anti-bot, drops iframe/JSON-LD, no record of how a result was produced. Captatum
differs on the axes that matter for autonomous agents:

- **Renders when needed** — anti-bot `wreq-js` Tier-1 fetch, lazy Playwright
  Tier-3 render only for empty SPA shells, structured-data extraction.
- **Provenance by default** — every response carries how it was produced, so a
  downstream gate can decide trust and a human can audit what an agent pulled.
- **MCP-native** — reachable as a named tool from Claude.ai and ChatGPT today.

## Quick start

```bash
corepack pnpm install            # pnpm 10.32.0 via corepack
corepack pnpm run check          # syntax + 250-line limit + typecheck
corepack pnpm run smoke          # lifecycle smoke (hosted + stdio)

# Single-URL diagnostic against the real pipeline:
PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright" \
  node --no-warnings src/dev/render-probe.ts "<url>" [--render]

# Live assertion suite (Tier-1/3, SSRF, the fixes):
node --no-warnings src/dev/url-suite.ts
```

Two deployment flavors off one core:

- **Hosted remote server** — Streamable HTTP `/mcp` + gateway OAuth, reached by
  web agents. Entry: `src/server.ts`.
- **Self-contained local binary** — same engine, no auth, single-user. Entry:
  the stdio bridge `src/interfaces/mcp/stdio-bridge.ts`.

See `docs/contracts.md` (the spec), `docs/threat-model.md`, and
`docs/dependency-ledger.md`.

## Tool name note

The product and package are **Captatum**. The MCP **tool identifier is
`smart_fetch`** (already wired into live ChatGPT/Claude.ai configs — renaming it
would break those connections), and internal file/identifier names are
unchanged. Only the public brand and wire-visible strings were renamed.

## Ecosystem

- **Edictum** — runtime trust layer for AI workers. Captatum is the governed
  fetch step Edictum gates can cite (`fetch-before-cite`): the agent may assert a
  claim about a URL only if a governed Captatum call produced evidence for it.
  The gate enforces evidence *presence* (a page was fetched at a time via a tier
  with a hash), not factual *truth*.
- **Qratum** — local-first provenance vault. Captatum can write resolved content
  + provenance as a content-addressed blob (a `web-fetch` source type),
  respecting Qratum's no-raw-upload posture.
- **Ductum** — internal factory/control-plane. Captatum registers as a governed
  factory tool; its audit shape maps to a Ductum per-attempt record.

Captatum stays **standalone**: the browser/SSRF blast radius must not be folded
into the trust layer.

## Status

Hosted deployment live (ECS/Fargate + Cloudflare Tunnel + Cloudflare Access +
TiDB), connected to ChatGPT and Claude.ai. Known gaps and the roadmap live in
`docs/contracts.md` and `docs/test-urls.md`. MIT licensed.

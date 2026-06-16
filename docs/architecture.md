# Architecture

Status: v1 direction. The guarded egress primitive, Tier-1 extraction,
adapter registry seam, gated Tier-3 render, OAuth state stores, and hosted
OAuth route/use-case slice are implemented; the remaining vertical slice
(transform, MCP server) is next. This document describes the approved shape.
`docs/contracts.md` is the source of truth for tool I/O, ports, provenance,
OAuth, and errors; this file does not duplicate it.

## Shape

Two deployment flavors off **one core engine**:

- **Hosted remote server** (primary). Streamable HTTP `POST /mcp` + gateway-owned
  OAuth, on Node 24 native TS. Reachable from every client including web agents
  (claude.ai, chatgpt.com), which cannot use a stdio bridge. Containerized,
  mirroring `personal-memory-gateway`'s ECS/cloudflared path.
- **Self-contained local binary**. The same engine compiled (Bun `--compile`)
  into one executable an agent runs locally — no deployment, **no auth**,
  single-user/single-agent. `wreq-js` native prebuilts bundle alongside.

Auth is conditional on flavor, not on code path: the engine is identical; the
local-binary flavor simply runs without an auth port.

## Layers

- `src/domain`: tool contract types, provenance records, and pure policy. No
  infrastructure imports.
- `src/application`: `ports/` + `use-cases/` + `queries/`. Depends on ports, not
  concrete adapters.
- `src/infrastructure`: concrete adapters behind ports (`wreq/`, `playwright/`,
  `sqlite/`, `tidb/`, `llm/`, `<platform>/`).
- `src/interfaces`: HTTP + MCP entrypoints.
- `src/config.ts`: centralized configurable values.
- `src/dev`: local checks and scaffold smoke tests.
- root `src/*.ts`: CLI/compat entrypoints.

Domain code must not import infrastructure. Application code depends on ports,
not concretes.

## Port contracts

- **`FetcherPort`** — the single hardened egress.
  `fetchGuarded(url, opts) → { status, finalUrl, redirects, bodyStream, contentType, bytes } | RejectResult`.
  Every outbound request — Tier-1, Tier-2 adapter, every redirect hop, every
  Tier-3 in-browser request — routes through it. This is where the rebinding-proof
  SSRF invariants live.
- **`PlatformAdapter`** + registry — optional known-platform short-circuit.
  `{ id, detect(ctx), resolve(input, fetcher) }`, registered in
  `src/application/adapters.ts`. Adding a platform = one folder under
  `src/infrastructure/<platform>/` + one registry line + one fixture. Not part of
  the public contract.
- **`StorePort`** — OAuth state only (auth codes + refresh tokens, hashed). Two
  implementations, one per flavor:
  - hosted flavor → **TiDB via `mysql2`**, reusing `personal-memory-infra`'s TiDB
    (EC2, private `REDACTED_TIDB_HOST:4000`, MySQL protocol): new `smartfetch` database +
    restricted `smartfetch_rw` user + a TiDB-SG rule allowing smart-fetch's task SG
    on `4000/tcp`. Mirrors how `personal-memory-gateway` connects.
  - local-binary flavor → **`node:sqlite`**, file on disk, no server.
- **`ModelRouterPort`** — `pick(task, inputTokens): { provider, model }` +
  `feedback(model, score)` for the bandit. Implemented by
  `src/infrastructure/llm/model-router.ts`.

## Adaptive pipeline

```text
smart_fetch(url, { prompt?, output?, schema?, budget?, transform?, maxBytes?, timeoutMs?, allowRender? })
  0. guardedFetch(url)                 ← the ONLY egress primitive (rebinding-proof SSRF)
  1. TIER-1  wreq-js fetch (TLS fingerprint, anti-bot) + raw-HTML/JSON-LD extraction + shell-gate
  2. TIER-2  [optional] platform adapter short-circuit (clean JSON via public API)
  3. TIER-3  Playwright render (lazy dynamic import) → extract (gated by allowRender, default false)
  4. TRANSFORM (DEFAULT)  OpenRouter/Ollama summarize|extract via the model router
  → summary (default) | raw | extract + provenance
```

- **Tier-1** is `wreq-js` (Rust-powered browser TLS/JA3+JA4 fingerprint
  impersonation → anti-bot/Cloudflare bypass). Raw-HTML extraction reads JSON-LD,
  Open Graph/twitter meta, canonical, and embedded app state
  (`__NEXT_DATA__`, `__INITIAL_STATE__`) via a prototype-pollution-safe reviver. A
  shell-gate decides real content vs. empty SPA shell.
  **Known P1 limitation:** the guarded requester uses `wreq-js` only for plain
  HTTP. HTTPS delegates to the Node requester so the adapter can connect to the
  checked IP while preserving original-host SNI/certificate verification. That
  keeps the SSRF invariant but means `wreq-js` TLS/JA3+JA4 anti-bot behavior is
  not active for HTTPS until a checked-IP + original TLS identity path is proven
  through `wreq-js`.
- **Tier-2** adapters resolve via a platform's public API when detected. Optional
  and general; endpoints live in adapter code/fixtures.
- **Tier-3** renders with Playwright when Tier-1 finds an empty SPA shell or no
  usable structured data (client-rendered React/Vue/Svelte, JS-only docs/demos,
  anti-bot interstitials, embedded third-party widgets). Gated by `allowRender`
  (default **false**) so a bare `smart-fetch` never spawns a browser. The
  adapter uses lazy `import('playwright')`, disables Service Workers, blocks
  downloads, closes WebSockets, routes document/script/fetch/XHR/style requests
  through `FetcherPort`, checks blocked body types with the same P1 URL/DNS
  private-IP guard before aborting them, and returns `page.content()` to the
  Tier-1 extractor with tier-3 provenance.
- **Transform** is the **default** output path (`output: summary`): resolved
  content → token-efficient answer to `prompt` via the free-model router. If no
  transform provider is configured, it degrades to `output: raw` and provenance
  records `transform: { provider: "none", reason: "unconfigured" }`. Because
  summary is the default, this setup is first-run-critical and must be documented
  prominently in the tool description and `docs/`.

## OAuth flow (hosted flavor only)

Applies only to the hosted flavor; the local-binary flavor has no auth. Mirrors
`personal-memory-gateway`. `docs/contracts.md` §OAuth is the canonical reference.

```text
authorize (PKCE S256, request-bound signed consent token)
  → approve  (single-use code, stored as sha256(code); 302 ?code=&iss=&state=)
  → token    (verify PKCE; issue ES256 JWT access token signed by OAUTH_SIGNING_PRIVATE_JWK,
              aud=resource; rotating refresh tokens stored as sha256(raw), grouped by family;
              replay revokes the family)
```

Auth-code TTL 300 s; access TTL 600 s; refresh TTL 30 days. Hosted production
requires `OAUTH_CONSENT_SIGNING_SECRET` + `OAUTH_SIGNING_PRIVATE_JWK` (fail-fast
at boot). Scopes: `fetch:read` (default), `fetch:transform`; raw fetch requires
read and summary/extract/transform requires transform. `docs/threat-model.md`
covers auth limits.

## Rebinding-proof SSRF invariants

The single egress primitive (`FetcherPort` / `guardedFetch`) holds these
invariants; `docs/threat-model.md` is the security reference.

- scheme `http|https` only; reject raw CRLF; reject userinfo-bearing URLs.
- resolve → `isPrivate` CIDR (exhaustive — see threat model) → connect to the
  **resolved IP** (`node:https` with `servername`/`Host` = original host).
- manual redirects re-validated each hop (`maxHops=5`).
- decompressed-byte cap; `AbortController` timeout.
- Tier-1 `wreq-js` egress lives behind this guard. It must receive the already
  validated connection target; direct `wreq-js` fetches are not a safe substitute.
  Current guarded Tier-1 HTTPS requests intentionally use the Node fallback above
  rather than weakening checked-IP connect semantics.
- Tier-3 in-browser: `page.route` guards every browser request; document/script/
  fetch/XHR/stylesheet requests are fulfilled only through `FetcherPort`;
  image/font/media/analytics URLs are P1 URL/DNS private-IP checked and aborted;
  WebSockets are closed; Service Workers off; downloads blocked; render-byte cap;
  browser in a separate child process with no env; OS sandbox on (never
  `--no-sandbox`).

## File Size Rule

TypeScript source files must stay at or below 250 lines:

```bash
pnpm run check:lines
```

Split by layer or responsibility when a file gets close to the limit.

## Not Implemented Yet

- The guarded fetch egress primitive, Tier-1 requester seam/extraction, the
  Tier-2 adapter registry seam, gated Tier-3 Playwright render, both `StorePort`
  impls, and hosted gateway OAuth route/use-case slice exist. The Transform
  router and the Streamable HTTP MCP server are still pending.
  `docs/contracts.md` describes the whole product; nothing is version-gated or deferred, it all gets built.

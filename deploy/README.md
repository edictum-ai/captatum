# Self-hosting Captatum (hosted flavor)

Captatum's **hosted flavor** is a Streamable-HTTP MCP server (`POST /mcp`) with
gateway-owned OAuth, reachable from web agents (claude.ai, chatgpt.com). This guide
covers the **common setup** and three one-click targets: **Railway**, **EC2**, and
**Mac Mini + Cloudflare**.

The common setup is intentionally dependency-light:

- **State**: a local **SQLite file** (the default OAuth-state store — no database).
  Set `TIDB_HOST` only if you want the optional TiDB scale path.
- **Auth**: gateway OAuth **+ Cloudflare Access** in front of the consent screen.
- **Tier-3 rendering**: a separate **browser sidecar** container (blast-radius
  separation — a browser compromise never reaches OAuth keys / the SQLite file).

```
                 Cloudflare Access (consent identity)
                          │  Cloudflare Tunnel
                          ▼
   ┌──────────────────────────────────────────────┐
   │ captatum gateway  (OAuth keys, SQLite file)  │  127.0.0.1:3000
   │       │ CDP                                    │
   │       ▼                                        │
   │ captatum-browser (Chromium, no secrets)       │
   └──────────────────────────────────────────────┘
```

## 1. Required secrets

Copy `.env.example` to `.env` and fill it in.

Generate the OAuth signing material once (prints export-ready env lines):

```sh
node --no-warnings scripts/gen-oauth-keys.ts
# -> OAUTH_SIGNING_KEY_ID, OAUTH_SIGNING_PRIVATE_JWK, OAUTH_CONSENT_SIGNING_SECRET
```

Set the deploy-specific values:

- `OAUTH_ISSUER`, `OAUTH_RESOURCE` — your gateway's public origin (e.g.
  `https://captatum.your-domain.com`). `ISSUER` and `RESOURCE` are usually equal.
- `OAUTH_REDIRECT_ALLOWLIST` — exact connector origins (e.g.
  `https://claude.ai,https://chat.openai.com`). Never `*`.
- `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS` — the public host/origin(s) clients
  reach (inbound DNS-rebinding protection).
- `CAPTATUM_SQLITE_PATH` — the SQLite store path. The code default is `./data/captatum.sqlite` (resolved against the container's CWD `/app`); set this to `/data/captatum.sqlite` on a mounted volume, as the templates below do — `/app` is root-owned under `USER node`, so the default path is **not writable** there and boot fails with `EACCES` (#85).

## 2. Cloudflare (Access + Tunnel)

The hosted flavor **requires Cloudflare Access** (it fail-closes at boot without
`CF_ACCESS_ENABLED=true` + audience/certs/issuer):

1. **Cloudflare Tunnel** (`cloudflared`) from your host to `127.0.0.1:3000`, exposing
   your public hostname (e.g. `captatum.your-domain.com`).
2. **Cloudflare Access application** on the tunnel hostname, scoped to a policy that
   holds the consent identity (e.g. an email allowlist) on `/oauth/authorize*`.
3. Put the Access app's **AUD**, **issuer** (`https://<team>.cloudflareaccess.com`),
   and **certs URL** (`.../cdn-cgi/access/certs`) into the `CF_ACCESS_*` env vars.

## 3. Targets

| Target | Guide | Notes |
| --- | --- | --- |
| **Railway** | [`railway.md`](./railway.md) + `railway.toml` | One gateway service from the published image + a `/data` volume. **Tier-3 needs the browser sidecar in the gateway's network namespace** (CDP is loopback-only) — so on Railway run gateway + sidecar in ONE service, not a separate one (a second service can't reach `127.0.0.1:9222`). |
| **EC2** | [`ec2-user-data.sh`](./ec2-user-data.sh) | cloud-init: installs Docker and runs `docker compose up -d` with the gateway + sidecar. |
| **Mac Mini** | [`mac-mini.md`](./mac-mini.md) | `cloudflared` + `docker compose` on macOS. |

All three use the same `docker-compose.yml` and the same `.env`, so the setup is
identical apart from how the host is provisioned and how `cloudflared` is run.

## Verifying

```sh
curl -sf https://captatum.your-domain.com/healthz   # -> {"status":"ok"}
```

Then register the MCP server in your client (claude.ai / ChatGPT connector) with the
public origin and complete the OAuth consent flow (fronted by Cloudflare Access).

## Scaling beyond a single instance

SQLite is single-node. For HA / multi-replica, opt into TiDB by setting `TIDB_HOST`
(+ port/database/user/password and `TIDB_SSL_CA`; TLS required). See
`docs/contracts.md` "Storage".

## Troubleshooting

The gateway boot **fails closed** on any missing required secret — by design. Logs
go to stdout as JSON: `docker compose -f deploy/docker-compose.yml logs -f gateway`.

| Symptom | Cause / fix |
| --- | --- |
| `HostedFlavorError` / container exits at boot | Set `CAPTATUM_FLAVOR=hosted` (the compose file sets it; if you bypass `.env`, ensure it's present). |
| Boot aborts "Hosted requires …" | A required secret is missing: `OAUTH_CONSENT_SIGNING_SECRET` + `OAUTH_SIGNING_PRIVATE_JWK` (`gen-oauth-keys.ts`), all four `CF_ACCESS_*`, and `MCP_ALLOWED_HOSTS` + `MCP_ALLOWED_ORIGINS`. |
| `summary` returns raw (`transform.provider: "none"`) | No transform provider: set `OPENROUTER_API_KEY` (or `OLLAMA_BASE_URL`). **Or** the caller's token lacks the `fetch:transform` scope (default `fetch:read` only allows `raw`). |
| Tier-3 `render-unavailable` | The gateway can't reach the browser sidecar. `CAPTATUM_BROWSER_CDP_ENDPOINT` must be `http://127.0.0.1:9222` and the sidecar must share the gateway's network namespace (`network_mode: service:gateway` in compose). |
| `~/.env` not picked up | compose `env_file` is `../.env` (repo root), and `environment:` overrides it — set secrets in `.env`, flavor/host/CDP via compose. |

## Upgrading

Pull a newer `CAPTATUM_TAG` and recreate: `docker compose -f deploy/docker-compose.yml up -d`.
OAuth state persists in the `captatum-data` SQLite volume. Re-running
`gen-oauth-keys.ts` rotates the signing key and **invalidates all previously issued
tokens** (every client must re-authorize).


# smart-fetch Deploy Runbook

Status: hosted-flavor packaging mirroring `personal-memory-gateway`; **not yet deployed**. Reuses the `personal-memory-infra` ECS/Fargate + cloudflared + TiDB topology.

## Build

```bash
cd /Users/acartagena/project/smart-fetch
corepack pnpm run check
IMAGE_TAG="$(git rev-parse --short=12 HEAD)"
AWS_PROFILE=REDACTED_PROFILE ./ops/aws/build-and-push-smart-fetch-image.sh "$IMAGE_TAG"
```

The Dockerfile pins the same ARM64 base as personal-memory-gateway:

```text
node:24.16.0-bookworm-slim@sha256:1df790a7d590f617d0d3c2cd84cbe18b5400ff972dd9701670f7e5a4f1634e52
```

Local sanity build (no push): `docker build -t smart-fetch:local .`

## Production env expectations

The ECS task must set (see `.env.example` for the full template):

```text
NODE_ENV=production
SMART_FETCH_FLAVOR=hosted
HOST=0.0.0.0
PORT=3000
OAUTH_ISSUER=https://smart-fetch.<your-domain>
OAUTH_RESOURCE=https://smart-fetch.<your-domain>
MCP_ALLOWED_HOSTS=smart-fetch.<your-domain>
MCP_ALLOWED_ORIGINS=https://claude.ai,https://chatgpt.com
TIDB_HOST=REDACTED_TIDB_HOST
TIDB_PORT=4000
TIDB_DATABASE=smartfetch
TIDB_USER=smartfetch_rw
```

Secrets — never in OpenTofu state or shell output, inject via Secrets Manager / task env:

- `OAUTH_SIGNING_PRIVATE_JWK` — ES256 (P-256) private key as JWK. **Required**; the server fail-fast aborts without it. Generate e.g. `node -e "import('jose').then(async j=>{const{k}=await j.generateKeyPair('ES256');console.log(JSON.stringify(await j.exportJWK(k.privateKey)))})"`.
- `OAUTH_CONSENT_SIGNING_SECRET` — HMAC secret for consent tokens. **Required**.
- `TIDB_PASSWORD` — the `smartfetch_rw` password.
- `OPENROUTER_API_KEY` — optional; free models work without it (rate-limit faster). Default models are discovered live from `/models`.

## First-deploy prerequisites (one-time)

1. **TiDB** on the existing instance (`REDACTED_TIDB_HOST:4000`): create the `smartfetch` database + a restricted `smartfetch_rw` user, and add a TiDB-SG rule allowing the smart-fetch task SG on `4000/tcp` — mirroring how `personal-memory-gateway` connects.
2. **ECR**: `aws ecr create-repository --repository-name smart-fetch --profile REDACTED_PROFILE --region REDACTED_REGION`.
3. **OAuth keys**: generate the ES256 JWK; the server publishes the public JWKS at `/oauth/jwks`.
4. **Smoke**: `corepack pnpm run smoke:hosted` against a real MCP client before cutover, plus a `/healthz` check through Cloudflare Tunnel.

## Cloudflare

Cloudflare Tunnel as the public ingress; Cloudflare Access limited to the OAuth consent path. Remote MCP clients (claude.ai, chatgpt.com, Claude CLI, Codex) use gateway OAuth bearer tokens against `POST /mcp`. Mirror `personal-memory-infra`'s ECS + cloudflared sidecar.

## Not yet production-ready

- **Tier-3 render is broken** (route-state timeout). The image ships Playwright module-only; `allowRender` defaults false, so `/mcp` serves Tier-1/2 + transform. Do not enable `allowRender` until fixed.
- **`hono` audit (HIGH, via `@modelcontextprotocol/sdk`) is open** — resolve before cutover.

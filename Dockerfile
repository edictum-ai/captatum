# smart-fetch hosted MCP server. Mirrors personal-memory-gateway's image shape:
# Node 24 native TS (no build step), pnpm 10.32.0 via corepack, --prod --frozen-lockfile.
#
# Tier-3 (Playwright) ships module-only here — PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# means no Chromium in the image, so render reports render-unavailable. To enable
# Tier-3, switch to a Playwright browser base (or apt-get browser deps) once the
# renderer route-state bug is fixed. Tier-1/2 + transform + OAuth + SSRF run fine.
FROM node:24.16.0-bookworm-slim@sha256:1df790a7d590f617d0d3c2cd84cbe18b5400ff972dd9701670f7e5a4f1634e52

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

RUN corepack enable \
  && corepack prepare pnpm@10.32.0 --activate \
  && pnpm install --prod --frozen-lockfile

COPY src ./src

USER node

EXPOSE 3000

CMD ["node", "--no-warnings", "src/server.ts"]

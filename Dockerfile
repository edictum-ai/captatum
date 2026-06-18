# smart-fetch hosted MCP server. Node 24 native TS, pnpm 10.32.0, Chromium for Tier-3.
FROM node:24.16.0-bookworm-slim@sha256:1df790a7d590f617d0d3c2cd84cbe18b5400ff972dd9701670f7e5a4f1634e52

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

RUN corepack enable \
  && corepack prepare pnpm@10.32.0 --activate \
  && pnpm install --prod --frozen-lockfile

RUN pnpm exec playwright install chromium --with-deps

COPY src ./src

USER node

EXPOSE 3000

CMD ["node", "--no-warnings", "src/server.ts"]

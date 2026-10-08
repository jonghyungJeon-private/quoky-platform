# syntax=docker/dockerfile:1
# UNC-1 harness image. Build with the repository root as the context (filtered by /.dockerignore, which drops every
# env-style file, .git, node_modules and build output):
#   docker build -f tools/uat/netfault/Dockerfile -t unc1-harness:local .
# Only an explicit allowlist is copied; credentials are passed at RUN time with --env-file and are never copied.

FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.build.json ./
COPY packages/ packages/
COPY apps/quoky/ apps/quoky/
RUN find . -name '.env*' -o -name '*.env' | grep -q . && { echo 'env-style file in the build context' >&2; exit 1; } || true
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Keep only what runs: package manifests, dist output and installed dependencies.
RUN find packages apps -mindepth 2 -maxdepth 2 -name src -type d -exec rm -rf {} + \
    && find packages apps -name '*.tsbuildinfo' -delete

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app /app
COPY tools/uat/netfault/ tools/uat/netfault/
ENV NODE_ENV=production
CMD ["node", "tools/uat/netfault/harness.mjs"]

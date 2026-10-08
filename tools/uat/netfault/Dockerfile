# syntax=docker/dockerfile:1
# UNC-1 harness image: the workspace built inside Linux (better-sqlite3 needs a linux/arm64 build for this Node).
# Build with the worktree as the context; it is bind-mounted READ-ONLY and copied without .git, node_modules, build
# output or any env file:  docker build -f tools/uat/netfault/Dockerfile -t unc1-harness:local .
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app
RUN --mount=type=bind,source=.,target=/src,readonly \
    tar -C /src \
      --exclude=./.git --exclude='node_modules' --exclude='dist' --exclude='*.tsbuildinfo' \
      --exclude='.env' --exclude='.env.*' --exclude=./.uat --exclude=./.chunsik-tmp --exclude=./data --exclude=./.chunsik \
      -cf - . | tar -xf - \
    && test ! -e /app/.env.local
RUN pnpm install --frozen-lockfile
RUN pnpm build
ENV NODE_ENV=production
CMD ["node", "tools/uat/netfault/harness.mjs"]

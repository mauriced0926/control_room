# The control room service. Node 24 runs the TypeScript directly; there is no build step.
# Multi-arch base (amd64 and arm64). Pinned to the version node:sqlite was checked on: no
# ExperimentalWarning at start-up (TESTING.md L13.3).
FROM node:24.15.0-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY config ./config

# The command and audit log lives in a volume, owned by the unprivileged user that runs the service.
RUN mkdir -p /app/data && chown node:node /app/data
USER node

ENV HOST=0.0.0.0 PORT=8090 DATA_DIR=/app/data
EXPOSE 8090
CMD ["node", "src/main.ts"]

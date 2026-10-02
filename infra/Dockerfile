# Exact release tags are used; release promotion additionally records image digests.
FROM node:24.19.0-bookworm-slim AS builder
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.server.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts/operations ./scripts/operations
COPY scripts/migrate.ts scripts/setup.ts ./scripts/
COPY infra/migrations ./infra/migrations
ARG RELEASE_REVISION=unknown
ENV BUILD_ID=$RELEASE_REVISION
RUN npx tsc -p tsconfig.server.json && npx vite build --config apps/web/vite.config.ts

FROM node:24.19.0-bookworm-slim AS dependencies
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.19.0-bookworm-slim AS runtime
ARG RELEASE_REVISION=unknown
LABEL org.opencontainers.image.title="Counter POS" \
      org.opencontainers.image.revision=$RELEASE_REVISION
ENV NODE_ENV=production PORT=3000 RELEASE_REVISION=$RELEASE_REVISION
WORKDIR /workspace
COPY --from=dependencies --chown=node:node /workspace/node_modules ./node_modules
COPY --from=dependencies --chown=node:node /workspace/package.json ./package.json
COPY --from=builder --chown=node:node /workspace/build/server/apps ./build/server/apps
COPY --from=builder --chown=node:node /workspace/build/server/packages ./build/server/packages
COPY --from=builder --chown=node:node /workspace/dist ./dist
COPY --from=builder --chown=node:node /workspace/infra/migrations ./infra/migrations
COPY --chown=node:node infra/healthcheck.mjs ./infra/healthcheck.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 CMD ["node", "infra/healthcheck.mjs"]
CMD ["node", "build/server/apps/api/src/main.js"]

# Operator jobs have PostgreSQL 16 tools and are never run as the serving process.
FROM postgres:16.13-bookworm AS operations
ARG RELEASE_REVISION=unknown
ENV NODE_ENV=production PG_BIN=/usr/lib/postgresql/16/bin RELEASE_REVISION=$RELEASE_REVISION
WORKDIR /workspace
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies --chown=postgres:postgres /workspace/node_modules ./node_modules
COPY --from=dependencies --chown=postgres:postgres /workspace/package.json ./package.json
COPY --from=builder --chown=postgres:postgres /workspace/build/server ./build/server
COPY --chown=postgres:postgres infra/migrations ./infra/migrations
USER postgres
ENTRYPOINT ["node", "build/server/scripts/operations/cli.js"]
CMD ["help"]

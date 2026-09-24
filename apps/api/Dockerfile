FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/node-agent/package.json ./apps/node-agent/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/launcher/Cargo.toml ./apps/launcher/Cargo.toml
COPY apps/launcher/package.json ./apps/launcher/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/rating/package.json ./packages/rating/package.json
RUN npm ci

COPY apps/api/src ./apps/api/src
COPY apps/api/tsconfig.json apps/api/tsup.config.ts ./apps/api/
COPY packages/contracts/src ./packages/contracts/src
COPY packages/db/src ./packages/db/src
COPY packages/rating/src ./packages/rating/src
RUN npm run build --workspace @aftertick/api && npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime

ENV NODE_ENV=production
ENV PORT=8787
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node packages/db/migrations ./apps/api/migrations
COPY --chown=node:node scripts/start-observed-api.mjs ./scripts/start-observed-api.mjs
USER node
EXPOSE 8787
CMD ["node", "scripts/start-observed-api.mjs"]

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

COPY apps/web ./apps/web
COPY packages/contracts/src ./packages/contracts/src
COPY packages/rating/src ./packages/rating/src
RUN npm run build --workspace @aftertick/web

FROM nginx:stable-alpine@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46 AS runtime

COPY deploy/nginx.conf /etc/nginx/nginx.conf
RUN nginx -t
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1

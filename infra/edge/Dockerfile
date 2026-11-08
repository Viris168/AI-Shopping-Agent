# Edge image: Caddy + the widget bundle. Build context is the repo root:
#   docker build -f infra/edge/Dockerfile .
FROM node:24-slim AS widget
WORKDIR /w
COPY widget/package.json widget/package-lock.json ./
RUN npm ci
COPY widget/ ./
# Type check, bundle and fail over the 40 KB gzipped budget.
RUN npm run build

FROM caddy:2
COPY infra/edge/Caddyfile /etc/caddy/Caddyfile
COPY --from=widget /w/dist/widget.js /srv/widget/widget.js

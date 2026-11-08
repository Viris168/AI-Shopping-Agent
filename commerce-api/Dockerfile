FROM node:24-slim AS build
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /srv
# Files stay root-owned, so the app (uid 1000 `node`) can read but not modify its own code.
COPY --from=build /srv/package.json ./
COPY --from=build /srv/node_modules ./node_modules
COPY --from=build /srv/dist ./dist
USER node:node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Secrets (JWT_SECRET, SERVICE_TOKEN, DATABASE_URL) come from the runtime environment, never the image.
# Migrations run as a separate job: npm run migration:run:prod
CMD ["node", "dist/main"]

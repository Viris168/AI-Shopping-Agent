FROM node:24-slim AS build
WORKDIR /srv
COPY package.json package-lock.json ./
# CPU only: don't download onnxruntime's ~270 MB CUDA/TensorRT libraries (embedding model, src/search/).
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
# Embedding runtime trimmed to what Linux needs: no macOS/Windows builds, no browser runtime
# (onnxruntime-web, ~140 MB; transformers.js uses onnxruntime-node under Node).
RUN npm run build && npm prune --omit=dev \
  && rm -rf node_modules/onnxruntime-node/bin/napi-v*/darwin node_modules/onnxruntime-node/bin/napi-v*/win32 \
     node_modules/onnxruntime-web
# Bake the embedding model into node_modules so production never downloads it (src/search/embedding.ts).
# Embeds one query, so the build fails if the trimmed runtime can't run the model.
RUN node -e "import('./dist/search/embedding.js').then(async (m) => { const v = await new m.Embedder().embedQuery('test'); if (v.length !== m.EMBEDDING_DIMS) process.exit(1); })"

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

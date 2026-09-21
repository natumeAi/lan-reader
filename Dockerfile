FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY shared ./shared
COPY server ./server
COPY client ./client
RUN npm run build

# Native modules are installed for Linux, never copied from the host.
# Keep the workspace layout so the shared package link remains valid.
FROM node:22-bookworm AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci --omit=dev --workspace server --workspace shared --include-workspace-root=false
RUN node --input-type=module -e "import Database from 'better-sqlite3'; import sharp from 'sharp'; const db = new Database(':memory:'); db.prepare('SELECT 1').get(); db.close(); await sharp({create:{width:1,height:1,channels:3,background:'white'}}).webp().toBuffer();"

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV EPUB_DATA_DIR=/app/server/data
ENV DATABASE_PATH=/app/server/data/library.sqlite
COPY --from=production-deps /app ./
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/public ./server/public
RUN mkdir -p /app/server/data/books /app/server/data/covers \
  && chown -R node:node /app/server/data
USER node
VOLUME ["/app/server/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then(async r => process.exit(r.ok && (await r.json()).database === 'ok' ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/dist/index.js"]

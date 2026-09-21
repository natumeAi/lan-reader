FROM node:22-bookworm-slim AS client-deps
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci

FROM client-deps AS client-build
COPY client/ ./
RUN npm run build

FROM node:22-bookworm AS server-deps
WORKDIR /app/server
ENV NODE_ENV=production
COPY server/package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app/server

RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY --from=server-deps /app/server/node_modules ./node_modules
COPY server/package*.json ./
COPY server/src ./src
COPY --from=client-build /app/client/dist ./public

RUN mkdir -p data/books data/covers

VOLUME ["/app/server/data"]
EXPOSE 3000

CMD ["npm", "start"]

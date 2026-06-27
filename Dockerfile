# syntax=docker/dockerfile:1

# --- build stage: install prod deps (compiles the better-sqlite3 native addon) ---
FROM node:22-slim AS build
WORKDIR /app
# toolchain in case better-sqlite3 has no prebuilt binary for this platform
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

# --- runtime stage ---
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=prod
COPY --from=build /app ./
EXPOSE 3000
# migrate + seed are idempotent; safe to run on every boot before listening.
CMD ["sh", "-c", "node src/db/migrate.js && node src/db/seed.js && node src/server.js"]

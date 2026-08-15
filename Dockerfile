# Multi-stage: build with devDependencies and a compiler toolchain, ship
# only the production node_modules and compiled dist/. M9 adds an HTTP API
# (Hermes, on a different machine, reaches it over Tailscale) — the actual
# host binding lives in compose.production.yaml, not here; EXPOSE below is
# documentation only.

FROM node:22-alpine AS build

# better-sqlite3 compiles its native binding from source at install time —
# there is no prebuilt binary for this platform/Node combination (found
# rehearsing restore on Atlas, M8 part 2/3) — so a C++ toolchain is a real
# build-time dependency, not an optional extra.
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Drops devDependencies (and the C++ toolchain's own footprint) from the
# node_modules the runtime stage copies — the compiled native binding, built
# above against this same Alpine/musl base, stays intact through the prune.
RUN npm prune --omit=dev


FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY drizzle ./drizzle
COPY config/criteria.yaml ./config/criteria.yaml

# config/profile.yaml (gitignored, personal — ADR-004) and .env are never
# baked into the image; compose.production.yaml mounts/injects them at
# runtime. data/ (the SQLite database) is a named volume, not a layer.

EXPOSE 3000

CMD ["node", "dist/main.js"]

# Multi-stage: build with devDependencies and a compiler toolchain, ship
# only the production node_modules and compiled dist/. No exposed ports —
# this is a headless batch service (CLAUDE.md §4), not an HTTP server;
# M9 is what adds one.

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

CMD ["node", "dist/main.js"]

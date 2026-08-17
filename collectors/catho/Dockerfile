# Ephemeral collector for the Catho source (ADR-032).
#
# Built once on Atlas's host, run via `docker run --rm` on a schedule
# (systemd timer — see argos-catho-collect.timer, not committed to run
# until deployed deliberately). Never runs inside argos-career's own
# container — no Docker socket mounted there, same reasoning as
# collectors/indeed (ADR-027).
#
# Base image ships Chromium and every system dependency Playwright needs
# pre-installed — the whole reason to use it instead of a plain node:*
# image and running `npx playwright install-deps` by hand. Version pinned
# to match the `playwright` npm dependency in package.json exactly.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy@sha256:b3251f7ff1a9fa559a28d1c67eaa15fc1a9800f7845e82756caea7842967f615

WORKDIR /app
COPY package.json package-lock.json ./
# npm ci, not npm install (docs/audit AC-030): ci installs exactly what
# package-lock.json resolved and fails if it is out of sync with
# package.json; install re-resolves caret ranges (tsx's ^4.23.12 among
# them) against whatever is on the registry that day, so the same commit
# could silently produce a different image on every rebuild.
RUN npm ci

COPY state.ts safe-fetch.ts collect.ts requeue.ts ./

ENTRYPOINT ["npx", "tsx", "collect.ts"]

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
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app
COPY package.json .
RUN npm install

COPY state.ts collect.ts ./

ENTRYPOINT ["npx", "tsx", "collect.ts"]

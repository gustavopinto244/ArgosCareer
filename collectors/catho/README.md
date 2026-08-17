# Catho collector

The host-side piece ADR-032 builds: a Playwright-based collector that runs
**outside argos-career's own container** (no Docker socket mounted there,
same reasoning as `collectors/indeed`, ADR-027) and pushes results through
the authenticated ingest endpoint (`POST /runs/collect/external`).

**Read ADR-032 before touching this.** Unlike `collectors/indeed`
(ADR-028), this one does **not** break any of CLAUDE.md §6's polite-collector
rules — it never touches Catho's robots.txt-disallowed search path, and a
real Chromium User-Agent is an honest statement of what it is, not a forged
one. What makes this collector heavier than Gupy/Sólides is a real
structural fact, not a rule exception: Catho has no server-side search this
project can reach, so there is no way to ask for only Rio-de-Janeiro-metro
internships — every title-matched posting has to be opened once to learn
its real city.

## What runs where

- `collect.ts` + `Dockerfile` build **one image**, `argos-catho-collector:local`.
- A systemd **user** timer (`argos-catho-collect.timer`) fires the
  **service** (`argos-catho-collect.service`) every 30 minutes.
- The service runs `docker run --rm argos-catho-collector:local`, with the
  `data/` directory bind-mounted so the "already visited this posting ID"
  state file survives between ephemeral runs — the reason repeated runs
  make incremental progress instead of re-walking the whole candidate set.
- Each run: fetch Catho's vaga sitemaps (plain HTTP, no browser needed —
  not blocked), filter by title keyword, open up to `MAX_PAGES_PER_RUN`
  not-yet-seen postings with a real headless Chromium, extract each page's
  `application/ld+json` `JobPosting` markup and `<title>`, then `POST` the
  batch to `argos-career`'s own running container over its Tailscale
  address.

## First-time setup on Atlas

```bash
cd ~/apps/argos-career/app/collectors/catho

# 1. Build the image (once; rebuild after editing collect.ts, package.json
#    or Dockerfile)
docker build -t argos-catho-collector:local .

# 2. Configure
cp .env.example .env
# edit .env: ARGOS_API_URL (Atlas's Tailscale address, argos-career's port),
# ARGOS_API_KEY (the same key in ../../.env's API_KEY)
mkdir -p data

# 3. Try one run by hand before scheduling anything — with a small
#    MAX_PAGES_PER_RUN first, to see real output before committing to the
#    full ~6,800-posting backlog
set -a && source .env && set +a
docker run --rm \
  -v "$(pwd)/data:/data" \
  -e MAX_PAGES_PER_RUN=10 \
  -e REQUEST_INTERVAL_MS -e TITLE_PATTERN -e SEEN_IDS_PATH \
  -e ARGOS_API_URL -e ARGOS_API_KEY \
  argos-catho-collector:local

# 4. Install the systemd user units
mkdir -p ~/.config/systemd/user
cp argos-catho-collect.service argos-catho-collect.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now argos-catho-collect.timer

# 5. Confirm it's scheduled
systemctl --user list-timers argos-catho-collect.timer

# User units need a lingering session to run without an active login --
# otherwise systemd stops user services when the SSH session ends. Skip if
# already done for the Indeed collector — it's the same user.
loginctl enable-linger guga
```

## After editing `collect.ts`

```bash
docker build -t argos-catho-collector:local .
# next scheduled run (or a manual `systemctl --user start argos-catho-collect.service`)
# picks up the new image automatically -- no service/timer restart needed.
```

## Checking on it

```bash
systemctl --user status argos-catho-collect.service
journalctl --user -u argos-catho-collect.service -n 50
cat data/catho-seen-ids.json | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"
```

A run's outcome is also visible the normal way, once it has actually
POSTed: `GET /runs?kind=collect` on argos-career's own API -- this
collector's runs are indistinguishable from Gupy/Sólides/Indeed's in that
listing, by design (ADR-027, principle 2: one `collect` kind regardless of
trigger).

## Resetting the backlog

Delete `data/catho-seen-ids.json` (or the whole `data/` directory) to make
every title-matched posting a candidate again. Only useful deliberately
(e.g. `TITLE_PATTERN` widened to catch postings a narrower pattern missed)
-- routine operation never needs this, and doing it by accident means
re-walking the full nationwide backlog again.

## Changing the search

Edit `.env` (`TITLE_PATTERN`, `MAX_PAGES_PER_RUN`, `REQUEST_INTERVAL_MS`) --
no rebuild needed, these are read at container start. Same v1 simplification
as the Indeed collector (ADR-027): not wired into `config/criteria.yaml`,
to avoid cross-language config sharing for a single source.

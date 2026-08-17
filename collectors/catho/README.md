# Catho collector

The host-side piece ADR-032 builds: a Playwright-based collector that runs
**outside argos-career's own container** (no Docker socket mounted there,
same reasoning as `collectors/indeed`, ADR-027) and pushes results through
the authenticated ingest endpoint (`POST /runs/collect/external`).

**⚠ Not currently deployable.** Auditing this collector live
(`docs/audit/AUDIT-PRE-DEPLOY-2026-08-17.md`) found that Playwright's
default headless Chromium gets a `403` from Catho — the same block a
non-browser client gets, not solved by using a real Chromium engine. Do not
build/schedule this on Atlas until that is resolved. The checkpoint logic
below (`state.ts`) is correct and tested regardless of when that happens.

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
# ARGOS_INGEST_API_KEY (matches ../../.env's INGEST_CATHO_API_KEY)
mkdir -p data

# 3. Try one run by hand before scheduling anything — with a small
#    MAX_PAGES_PER_RUN first, to see real output before committing to the
#    full ~6,800-posting backlog
set -a && source .env && set +a
docker run --rm \
  -v "$(pwd)/data:/data" \
  -e MAX_PAGES_PER_RUN=10 \
  -e REQUEST_INTERVAL_MS -e TITLE_PATTERN -e STATE_PATH \
  -e ARGOS_API_URL -e ARGOS_INGEST_API_KEY \
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
python3 -c "
import json
state = json.load(open('data/catho-state.json'))['entries']
from collections import Counter
print(Counter(e['state'] for e in state.values()))
"
```

The state file (`data/catho-state.json`) tracks each posting ID's state --
`collected` (fetched, payload durable, waiting on ingest confirmation),
`ingested` (confirmed by argos-career's API, terminal), `expired`
(confirmed gone, terminal), `retryable` (a transient failure -- 429, 5xx,
timeout, or an unexplained non-2xx like Catho's headless-browser block --
retried automatically next run), or `quarantined` (5+ consecutive
retryable failures for the same ID -- stops being retried automatically,
but stays visible in the file rather than silently disappearing;
docs/audit AC-001/AC-002).

A run's outcome is also visible the normal way, once it has actually
POSTed: `GET /runs?kind=collect` on argos-career's own API -- this
collector's runs are indistinguishable from Gupy/Sólides/Indeed's in that
listing, by design (ADR-027, principle 2: one `collect` kind regardless of
trigger).

## Resetting the backlog

Delete `data/catho-state.json` (or the whole `data/` directory) to make
every title-matched posting a candidate again. Only useful deliberately
(e.g. `TITLE_PATTERN` widened to catch postings a narrower pattern missed)
-- routine operation never needs this, and doing it by accident means
re-walking the full nationwide backlog again. Deleting it also forgets any
`quarantined` IDs, giving them a fresh retry budget.

## Changing the search

Edit `.env` (`TITLE_PATTERN`, `MAX_PAGES_PER_RUN`, `REQUEST_INTERVAL_MS`) --
no rebuild needed, these are read at container start. Same v1 simplification
as the Indeed collector (ADR-027): not wired into `config/criteria.yaml`,
to avoid cross-language config sharing for a single source.

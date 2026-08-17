# Indeed collector

The host-side piece ADR-027 deferred and ADR-028 cleared to build: a
`jobspy`-based collector that runs **outside argos-career's own container**
(no Docker socket mounted there, deliberately — ADR-027) and pushes results
through the authenticated ingest endpoint (`POST /runs/collect/external`).

**Read ADR-027 and ADR-028 before touching this.** ADR-028 in particular:
this collector deliberately breaks CLAUDE.md §6's `robots.txt` and honest
User-Agent rules, for this one library and this one host only, with the
trade-off recorded there — not something to extend to another source by
copying this pattern.

## What runs where

- `collect.py` + `Dockerfile` build **one image**, `argos-indeed-collector:local`.
- A systemd **user** timer (`argos-indeed-collect.timer`) fires the
  **service** (`argos-indeed-collect.service`) twice daily.
- The service runs `docker run --rm argos-indeed-collector:local` — one
  ephemeral container per run, matching CLAUDE.md §6's "ephemeral Python
  container... prints JSON and exits."
- The container scrapes Indeed via `jobspy`, then `POST`s the results to
  `argos-career`'s own running container over its Tailscale address —
  container to container, both on Atlas, neither with any special
  privilege over the other.

## First-time setup on Atlas

```bash
cd ~/apps/argos-career/app/collectors/indeed

# 1. Build the image (once; rebuild after editing collect.py or Dockerfile)
docker build -t argos-indeed-collector:local .

# 2. Configure
cp .env.example .env
# edit .env: ARGOS_API_URL (Atlas's Tailscale address, argos-career's port),
# ARGOS_API_KEY (the same key in ../../.env's API_KEY)

# 3. Try one run by hand before scheduling anything
set -a && source .env && set +a
docker run --rm \
  -e SEARCH_TERM -e LOCATION -e COUNTRY_INDEED -e RESULTS_WANTED \
  -e ARGOS_API_URL -e ARGOS_API_KEY \
  argos-indeed-collector:local

# 4. Install the systemd user units
mkdir -p ~/.config/systemd/user
cp argos-indeed-collect.service argos-indeed-collect.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now argos-indeed-collect.timer

# 5. Confirm it's scheduled
systemctl --user list-timers argos-indeed-collect.timer

# User units need a lingering session to run without an active login —
# otherwise systemd stops user services when the SSH session ends.
loginctl enable-linger guga
```

## After editing `collect.py`

```bash
docker build -t argos-indeed-collector:local .
# next scheduled run (or a manual `systemctl --user start argos-indeed-collect.service`)
# picks up the new image automatically — no service/timer restart needed.
```

## Checking on it

```bash
systemctl --user status argos-indeed-collect.service
journalctl --user -u argos-indeed-collect.service -n 50
```

A run's outcome is also visible the normal way, once it has actually
POSTed: `GET /runs?kind=collect` on argos-career's own API — this
collector's runs are indistinguishable from Gupy/CIEE's in that listing,
by design (ADR-027, principle 2: one `collect` kind regardless of trigger).

## Changing the search

Edit `.env` (`SEARCH_TERM`, `LOCATION`, `RESULTS_WANTED`) — no rebuild
needed, these are read at container start. Unlike Gupy/CIEE's
`config/criteria.yaml`-driven queries, this collector's search parameters
are **not** in `criteria.yaml` — a deliberate v1 simplification (ADR-027)
to avoid building cross-language config sharing between this Python script
and the Node app for a single source. Revisit if a second external
collector like this one ever exists.

## Discovery coverage gap (docs/audit AC-023)

Each scheduled run issues exactly **one** jobspy search — one `SEARCH_TERM`,
one `LOCATION`, no rotation across runs. Unlike Gupy/Sólides, there is no
mechanism here for asking several questions in one cycle (ADR-018's
gender-variant terms, remote, or the other RJ-metro cities `location.cities`
in `criteria.yaml` accepts) — Indeed via this one env-configured query is
the whole of this source's discovery surface. `trainee` and `estagiário`/
`estagiária` variants, a `remote`-only query, and the other metro cities are
all structurally unreachable through Indeed today. Accepted, not fixed: a
second query means a second scheduled container run (this script has no
internal loop or multi-query concept, unlike the Node collectors), which is
real added complexity for a source whose main value — per ADR-027/028 — was
"one more source, cheaply," not comprehensive Indeed coverage. Revisit if
`SEARCH_TERM`/`LOCATION` rotation across scheduled runs (e.g. a second
timer with different `.env` values) turns out to be worth the extra
moving part.

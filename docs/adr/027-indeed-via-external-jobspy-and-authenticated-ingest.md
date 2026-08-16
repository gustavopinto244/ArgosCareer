# ADR-027 — Indeed via an external `jobspy` process, ingested through the API boundary

## Status

Accepted. Receiving side (schema, normalizer, ingest endpoint) implemented
and tested; the host-side collection script and its Atlas scheduling are not
— see Consequences.

## Date

2026-08-16

## Context

Google Jobs/Indeed is CLAUDE.md §6's P1 source, planned as "Ephemeral Python
container (`--rm`) running `python-jobspy`; prints JSON and exits." ADR-020
(2026-08-15/16) found the blocker: Indeed answers a plain HTTP request with a
Cloudflare "Security Check," which is what motivated lifting the memory
budget to allow a browser-capable collector at all.

**Verified live before writing any code**, per CLAUDE.md §15: `python-jobspy`
against `site_name=["indeed"]`, run in a throwaway `python:3.12-slim`
container, returned 8 real Rio de Janeiro internship postings —
`estagio desenvolvimento`, `country_indeed="Brazil"` — with real companies,
titles, descriptions and dates. Whatever `jobspy` does internally gets past
the Cloudflare check ADR-020 found. (The same probe against
`site_name=["google"]` returned zero results in two attempts — not
investigated further; this ADR is about Indeed only.)

That answers _whether_ jobspy works. It does not answer _how a source that
must run as an ephemeral Docker container gets its results into a Node
process that is itself already running inside a Docker container_ — a
question CLAUDE.md's plain-English description never actually settled, and
Gupy/CIEE never had to answer, since both are pure outbound HTTP calls
`GupyCollector`/`CieeCollector` make directly, needing no container
privilege of any kind.

## Considered options

### Mount the Docker socket into the argos-career container

Simplest to implement — the collector would just shell out to
`docker run --rm ...` via `child_process`, matching CLAUDE.md's description
almost literally. Rejected. `argos-career` already exposes an authenticated
HTTP/MCP surface reachable over Tailscale (ADR-017). A container with socket
access _and_ a network-facing API is a materially larger attack surface than
anything this project has built: a vulnerability in any dependency — Node,
NestJS, the MCP SDK, anything in `node_modules` — that yields code execution
would hand over control of Atlas's entire Docker host, portfolio and
task-manager included, not just this container. ADR-020 already accepted a
smaller version of this trade (IP-reputation risk from a browser-driven
collector); a socket mount is a categorically bigger one, and was rejected
on that basis, not the smaller-risk precedent ADR-020 set.

### Docker-in-Docker inside the argos-career container

Considered briefly, discarded without much analysis: still needs elevated
container privileges (typically `--privileged`) to run a nested daemon,
so it does not actually avoid the problem the socket-mount option has — it
relocates it.

### A host-side script, decoupled entirely, reporting in via the existing authenticated API (chosen)

`argos-career`'s own container keeps exactly the privilege posture it has
today — none. A separate process on Atlas's host (a cron job or systemd
timer, not committed to run yet — see Consequences) runs `jobspy` in its own
ephemeral container and pushes the results to `argos-career` over the same
Tailscale + Bearer-key boundary ADR-017 already built for Hermes. This is
not a new trust boundary; it is the existing one, given a second legitimate
caller.

### A shared file/volume instead of an API push

Considered as the alternative bridge mechanism once the host-script
direction was chosen. Rejected: it is new coordination machinery (staleness
checking, ownership, cleanup) for a problem ADR-017's authenticated HTTP
boundary already solves. The API route also means this ingest path is
testable the same way every other stage-trigger already is — no real
Docker, no real file I/O, in the suite.

## Decision

**`POST /runs/collect/external`**, authenticated by the same global
`ApiKeyGuard` every other route already requires. Body:
`{ source: string, postings: { sourceId: string, payload: unknown }[] }`.

No Zod schema at this HTTP boundary — `payload` is deliberately `unknown`,
validated tolerantly downstream by whichever normalizer `source` resolves
to, the same boundary Gupy/CIEE's own payloads already cross. The
controller checks only the request's own shape (`source` present,
`postings` an array) before handing off.

`RunsService.ingestExternal` rejects an unregistered `source` with 400
_before_ opening a run row — every item would be unnormalizable, and
recording a run to say so is not useful. Otherwise it calls
`executeIngestExternal` (`src/cli/main.ts`), the testable core: normalize
each item, upsert, count — structurally identical to `executeCollect`'s
inner loop, because it is the same operation once the network fetch is
already done. Same bookkeeping guarantee as every other stage (#49): a
throw closes the run row as `failed` rather than orphaning it.

**Shares the `collect` `RunLock` kind (ADR-024)** with the scheduled
Gupy/CIEE cycle and the manual `POST /runs/collect` — an external ingest
landing mid-cycle is the same class of race that guard already exists for,
extended to a new entry point at zero new cost.

**Indeed's payload schema and normalizer** (`indeed-schema.ts`,
`indeed-normalizer.ts`) follow Gupy/CIEE's exact tolerance discipline:
`.passthrough()`, everything but `id`/`title` optional, fitted to a real
captured response (`test/fixtures/indeed-raw.json`, gitignored) with a
fully fictional curated fixture (`indeed-jobs.json`) committed alongside its
provenance note, matching `gupy-jobs.md`/`ciee-jobs.md`'s convention.

Two structural facts worth naming, both load-bearing in the normalizer:

- **`location` is one free-text string** ("Rio de Janeiro, RJ, BR"), not
  Gupy's structured `city` field — the normalizer parses the first
  comma-separated segment.
- **`is_remote` is the only work-mode signal.** `false` maps to `unknown`,
  not `onsite` — jobspy cannot distinguish onsite from hybrid, and guessing
  would be exactly the invented fact CLAUDE.md §15 forbids.

**`date_posted` is real and present on every sampled row** — unlike CIEE
(`docs/11-known-issues.md` B1), Indeed states genuine publication dates, so
this source needs neither ADR-019's recency-window fallback nor ADR-011
Amendment 4's undated-backlog handling.

**No recency-window filtering (ADR-019) at ingest time**, deliberately out
of scope for v1: the pre-filter's `maxAgeDays` (ADR-011 Amendment 4) already
bounds what reaches the LLM regardless of which stage a posting entered
through. Skipping the window here costs extra storage of an old posting,
never extra LLM spend.

**No MCP tool.** This is a machine-to-machine ingest path for a host-side
script, not a capability Hermes has any reason to invoke — `McpController`
is unchanged.

## Consequences

**Easy:** the receiving side is complete, tested, and reuses every relevant
existing mechanism (ADR-017's auth boundary, ADR-024's overlap guard,
principle 1's normalize-returns-null-not-throw contract) rather than
inventing new ones. `argos-career`'s container privilege posture is
unchanged — still no Docker socket, still nothing beyond outbound HTTP and
the Telegram/OpenRouter calls it already makes.

**Not done, and this ADR is explicit about it:** the actual host-side
script that runs `jobspy` and calls this endpoint does not exist yet, nor
does its scheduling on Atlas (cron or systemd timer), nor a `criteria.yaml`
query configuration for what to search Indeed for. `POST
/runs/collect/external` is fully built, tested, and ready to receive —
nothing currently calls it in production. Indeed collection is not live
after this ADR merges; it becomes live once the host script ships as a
follow-up.

**A real, accepted gap:** the host script itself, wherever it runs, still
needs a way to authenticate — the same `API_KEY` every other caller of this
boundary uses. It is a plain file on Atlas's host either way (`.env` today);
this ADR does not change that exposure, only where the privileged Docker
operation happens.

**Reversal cost:** low on the receiving side (delete the route, the service
method, the normalizer, the schema — nothing else depends on any of them);
whatever cost exists is in the not-yet-written host script, not in this ADR.

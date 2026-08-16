# ADR-021 — Enable CIEE, and stop an unknown work mode from rescuing a known bad city

## Status

Accepted

## Date

2026-08-16

## Context

ADR-018 made collection queries configuration; PR #44 added a `CieeCollector`
without wiring it in. Turning it on needed two things decided.

**First, which collector answers a query.** `executeCollect` took a single
`CollectorPort` and ran every query against it — fine with one source, and
silently unable to grow. `collection.queries` had no way to say where a query
should go.

**Second, and only discovered by running it:** switching CIEE on took the
pre-filter's pass count from **127 to 1,987**. That was not a win. São Paulo
(216), Brasília (133), Fortaleza (77) and other out-of-region postings were
passing, and would have gone to Stage A as paid extractions.

The cause is ADR-011's symmetric leniency rule:

> Rejected only when `workMode` is known and not remote, **and** `location`
> is known and not in the configured cities.

That rule was written when Gupy was the only source and usually stated
`workMode`. **CIEE never states it** — the field does not exist on the
record — so every CIEE posting anywhere in Brazil passed on the theory that
it "cannot be ruled out as remote".

## Considered options

### Filter CIEE by city in the collector

Rejected as the primary fix. It would have narrowed collection, but the
postings already in the corpus would still pass, and the underlying rule
would still be wrong for any future source that omits `workMode`. It treats
the instance, not the class.

### Give CIEE postings a guessed `workMode`

Rejected outright. The source states nothing; inventing `onsite` would be the
normalizer lying to the rest of the pipeline about what it collected.

### Make the leniency asymmetric (chosen)

An unknown **location** still passes — it genuinely cannot be ruled out as
being in the target region. An unknown **work mode** no longer rescues a
posting whose city is known and outside it.

The asymmetry is the argument: absence of evidence about _how_ the work
happens does not outweigh positive evidence about _where_ it happens.

## Decision

**Queries name their source.** `CollectionQuerySchema` gains
`source`, defaulted to `gupy` so an existing criteria file keeps its meaning.
`collectorFor` (`posting/infrastructure/collector-registry.ts`) resolves it,
mirroring `normalizerFor` — one registry decides who fetches, the other who
parses, both keyed by the same string. A source not in both is not wired up,
and an unregistered source is reported as an error rather than skipped.

**Location leniency is asymmetric** (ADR-011 Amendment 3): reject when the
city is known and disallowed, regardless of work mode; keep passing an
unknown location.

**CIEE runs as one query, with no city filter.** It ignores every filter
parameter, so its collector sweeps the whole board (~58 requests) and filters
in memory — a second CIEE query would be a second full sweep for nothing.
Geography is left to the pre-filter, which now handles it correctly. Storing
the nationwide superior-level intake costs SQLite rows and nothing else: the
pre-filter still gates what reaches Stage A, so paid work is unchanged, and
M10's market analysis gets a national picture instead of a Rio-shaped one.

**`informática` joins the `dev` track keywords.** CIEE's role taxonomy calls
its technology category "Informática", a word Gupy's free-text titles never
use. Without it, all six CIEE IT postings classified `unknown` and scored
0.4 alignment instead of 1.0.

## Consequences

Measured end to end, against the real corpus:

|                        | before CIEE | after, before the fix | after both |
| ---------------------- | ----------- | --------------------- | ---------- |
| active postings        | 504         | 2,362                 | 2,362      |
| passing the pre-filter | 127         | **1,987**             | **291**    |
| of which CIEE          | —           | 1,860                 | 163        |
| **on-track**           | 8           | 8                     | **14**     |

The 1,700 postings that passed only because of the old rule were **all
CIEE** and **zero Gupy** — measured before changing it, which is why the
amendment could be made knowing it cost nothing that currently works.

**What this buys:** six real IT internships the pipeline could not see
before, at SERPRO, Banco do Brasil, the Instituto de Segurança Pública and
three IT-services firms — a 75% increase in the on-track pool.

**What it costs:** the corpus grew roughly fivefold, and a collection cycle
now takes about two minutes instead of thirty seconds, almost all of it
CIEE's 58-request sweep. Dedup is O(n²) within a company group and now scans
2,589 rows; it completed comfortably, but it is the thing to watch as the
corpus grows.

**Still unclaimed:** `requisitos.semestreInicio/semestreFinal` is preserved
in every CIEE posting's `rawPayload` but not yet read. It is the field
`CLAUDE.md` §9's period-blocked digest section has needed since M6, and
ADR-007's retained payloads mean claiming it later needs no re-collection.

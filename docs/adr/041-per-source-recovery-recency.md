# ADR-041 — Recovery recency is tracked per source, not per collect cycle

## Status

Accepted

## Date

2026-08-17

## Context

Item 5 of `docs/audit/POST_REMEDIATION_CHANGE_AUDIT_2026-08-17.md`'s
recommended fix order (§11), HIGH finding PR-003.

ADR-019 Amendment 1 built the gap-aware recovery window
(`computeRecencyWindowDays`) and named this exact limitation at the time,
deliberately deferred: the window is measured from the last _cycle-wide_
success (`findLatestFinished("collect", "success")`), not per source.
`executeCollect` marks a run `"success"` whenever not every query failed, so
one healthy source is already enough to keep the global timestamp advancing
every cycle — a different source can fail for days while every run still
reports "success" and the global clock never reflects that source's actual
outage. ADR-019 called this "a bigger change than [ADR-019's] finding's
concrete scenario (the whole app down) asked for."

The 2026-08-17 post-remediation audit re-raised it as PR-003 with a
concrete scenario: Sólides down for four days while Gupy stays healthy.
Every cycle reports "success." When Sólides recovers, `findLatestFinished`
still points at yesterday (a Gupy-carried success), so Sólides's own first
run back gets only the ordinary `recencyDays` window — postings published
during the first three days of its outage fall outside it and are never
collected, permanently. `evaluateCollectionHealth`'s alerting (the
mitigation ADR-019 Amendment 1 pointed to instead) tells a human a source is
failing; it does not, by itself, prevent the job loss once that source
recovers and the window has already been computed too narrow.

## Considered options

### Leave it to `evaluateCollectionHealth`'s alert, as ADR-019 Amendment 1 decided

Rejected now. The alert answers "is a source currently failing," which is
necessary but not sufficient — by the time a human sees it and the source
recovers, the narrow-window loss has already happened unless the recovery
window itself is also correct. The two are complementary, not substitutes.

### A new per-source cursor table

Considered. Rejected as unnecessary: `runs` already records, per finished
run, which sources were attempted and which failed (`attemptedSources`/
`failedSources`, both already `Set<string>` accumulated in
`executeCollect`). The only missing piece was persisting the first of those
two arrays and a query that reads them per source — not a new persisted
concept.

### Persist `attemptedSources` alongside the existing `failedSources`, derive per-source success by scanning run history

Accepted — see Decision.

## Decision

`runs` gains `attempted_sources` (nullable JSON text, same
serialize/parse precedent as `failed_sources`/`truncated_sources`;
migration `drizzle/0019`). `executeCollect` tracks it as a `Set<string>`
exactly like `failedSources`, populated the moment a query's `source` is
resolved (whether or not a collector is registered for it, whether or not
the collection call succeeds) — "was this source touched this run," a
strictly larger set than "did it fail."

`RunsRepository.findLastSuccessfulSourceCollectAt(source)` scans `collect`
runs newest-first and returns the `finishedAt` of the first one where
`source` appears in `attemptedSources` but not in `failedSources` —
independent of that run's own aggregate `outcome`, since (as ADR-019
Amendment 1's own text already established) the aggregate outcome cannot
distinguish a mixed-health cycle from a fully healthy one.

`executeCollect` no longer computes one `cutoff` before its query loop. A
memoized `cutoffForSource(source)` computes `computeRecencyWindowDays`
against that specific source's own `findLastSuccessfulSourceCollectAt`
result, the first time a query for it is seen — one lookup per distinct
source per run, not per query, so several queries against the same source
(Gupy's per-city queries) share one window.

## Consequences

- Closes PR-003: each source recovers postings published since its own
  last successful collection, not the whole cycle's. A source down for
  `backfillDays` or less recovers everything it missed the moment it
  succeeds again, regardless of how healthy every other source stayed in
  the meantime.
- Closes the limitation ADR-019 Amendment 1 named and deliberately left
  open — the "bigger change" it anticipated turned out to be one column and
  one repository method, reusing bookkeeping (`failedSources`) already in
  place rather than a new persisted concept.
- `computeRecencyWindowDays` itself is unchanged — still a pure function,
  still independently unit-tested. Only what calls it, and with which
  source's history, changed.
- One more repository read per distinct source per `collect` run
  (`findLastSuccessfulSourceCollectAt` scans the full `collect` run
  history). Same non-issue this project's other unbounded scans already
  are at this scale (a personal batch job, not a fleet) — matching the
  reasoning ADR-040's `claimForScoring`/`releaseUnresolvedClaims` and
  `findRunsSince(kind, null)` already rely on elsewhere in this codebase.
- **Reversal cost: low.** `cutoffForSource`/`findLastSuccessfulSourceCollectAt`
  have no other callers; reverting means restoring the single
  pre-loop `cutoff` computed from `findLatestFinished("collect", "success")`,
  with no migration to roll back (the column can simply go unused).

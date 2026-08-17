# ADR-019 — Collect by publication recency, with a wider first run

## Status

Accepted

## Date

2026-08-15

## Context

ADR-018 narrowed _what_ the collection cycle asks for and took the corpus
from 18 to 125 pre-filter-passing postings. It did not bound _how far back_
a cycle reaches. Every cycle asked the same question and got the same answer,
so the same postings came back every four hours; the fingerprint upsert
(ADR-007) meant re-sightings were cheap but not free, and the volume was
about to multiply as more sources land.

`Posting` had no way to express the problem. It carried `firstSeenAt` — when
**we** first observed a posting — and no field for when the **source**
published it. Those are different facts, and only the second one answers "is
this posting old?". A posting published last month and first collected today
has a `firstSeenAt` of today and looks brand new.

Gupy already stated the missing fact: `publishedDate` is present on
**300 of 300** postings sampled from the real corpus, ISO-8601. It was
validated by `GupyJobSchema` and then dropped on the floor by the normalizer.

## Considered options

### Deduplicate harder instead

Rejected. Re-sightings are already handled correctly by the fingerprint
upsert; the cost is the request and the parse, which dedup happens after.
It also does nothing about the real question, which is relevance: a posting
published six weeks ago is worse than one published yesterday even when it
is not a duplicate of anything.

### Filter on `firstSeenAt`

Rejected — it is the wrong fact. It would express "stop re-processing what we
have seen", which the upsert already does, and would never recognise a stale
posting on first sight.

### Filter on source publication date (chosen)

`Posting` gains `publishedAt`, mapped from what the source already states.
The cycle keeps only postings published within `collection.recencyDays`.

## Decision

**`Posting.publishedAt` is the source's publication date**, distinct from
`firstSeenAt`. New nullable column, new migration; `computeFingerprint` is
**not** touched — it is frozen under ADR-007, and changing it would rewrite
every stored fingerprint and re-notify the entire corpus.

**The window is one day** (`collection.recencyDays: 1`). Collection runs
every few hours, so a day is already generous overlap against a missed cycle.

**A null `publishedAt` passes.** Absence of a date is not evidence of an old
posting — the same leniency ADR-011 already applies to an unknown
`location`/`workMode`, and for the same reason: punishing a data gap as if it
were a bad answer discards good postings from sources that simply say less.

**The first run reaches back further** (`backfillDays: 7`), because there is
no earlier cycle that could have caught the past week. "First run" is
**derived, not stored**: no `collect` run with `outcome: "success"` on record.
That adds no new state to keep correct, and it is read _before_ the current
run is started, or the run would find itself.

**The drop count is reported** as `CollectOutcome.tooOld` and printed by the
CLI. A window quietly discarding everything must look different from a dead
source.

## Consequences

**Easy:** each cycle now processes roughly a day of new postings instead of
the whole standing result set, which is what makes several sources
affordable at all. Widening the window is a config edit, and the corpus is
never rewritten — nothing is deleted, only not re-fetched.

**Hard:** the window is only as good as the source's honesty about
`publishedDate`. A source that omits it gets no filtering at all (by design,
see the null rule), and a source that lies — restamping old postings as new,
which job boards do to look active — defeats it entirely. Neither is
detectable from our side.

**A real risk worth naming:** if collection is down for longer than
`recencyDays`, postings published during the outage fall outside the window
on the next successful run and are **never collected**. The first-run
backfill does not help, because a successful run already exists. The current
mitigation is the ratio — a 1-day window against a 4-hour cadence tolerates
five consecutive failures — plus `evaluateCollectionHealth`, which alerts
before that. A gap-aware window (measure from the last successful run rather
than from now) is the honest fix and is deliberately deferred until there is
a real outage to size it against.

**Reversal cost:** low. Removing `recencyDays` from `criteria.yaml` restores
unbounded collection via the schema default path; the `publishedAt` column
stays and is simply unread.

## Amendment 1 — 2026-08-17: the gap-aware window, no longer deferred

The "real risk worth naming" above predicted its own fix and deferred it
"until there is a real outage to size it against." A repository audit
(`docs/audit/AUDIT_REPORT.md` AC-028) found the same gap by reading the
code rather than living through an outage, and the fix is exactly the one
already named here.

**Decision:** `computeRecencyWindowDays` (`src/cli/main.ts`) replaces the
binary "first run vs. not" check. No successful `collect` on record still
means `backfillDays` (unchanged — there is no earlier cycle to measure a
gap against). Otherwise the window is
`clamp(daysSince(lastSuccessfulCollectAt), recencyDays, backfillDays)` — at
least `recencyDays` (a normal cycle's gap is a few hours, so this is what
actually governs day to day), and never more than `backfillDays` (an outage
of months does not become an unbounded backfill; recovering further than
that is a deliberate manual `--since-days` call, not automatic).

**Consequence, same shape as Amendment 4/5 of ADR-011:** this measures the
gap since the last _cycle-wide_ success (`runs.outcome = "success"` on any
`collect` run), not per source. A cycle where Gupy succeeds and CIEE fails
outright still counts as one success for this purpose (`executeCollect`
marks the whole run `"failed"` only when _every_ query fails), so a
single source down for days while the others keep succeeding does not get
its own extended window — it gets `recencyDays` like a normal cycle,
and depends on `evaluateCollectionHealth`'s alerting to surface the
per-source problem instead. Per-source recovery windows would need
per-source success tracking, a bigger change than this finding's concrete
scenario (the whole app down) asked for — deliberately not built here.

**Reversal cost:** low. `computeRecencyWindowDays` is a pure function with
its own unit tests, independent of the rest of `executeCollect`; reverting
means restoring the old `isFirstRun ? backfillDays : recencyDays` branch.

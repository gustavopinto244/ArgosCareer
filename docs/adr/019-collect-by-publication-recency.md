# ADR-019 — Collect by publication recency, with a wider first run

## Status

Accepted — amended 2026-08-17, see
[Amendment 1](#amendment-1--2026-08-17-the-gap-aware-window-no-longer-deferred)
and
[Amendment 2](#amendment-2--2026-08-17-per-source-recovery-closing-what-amendment-1-deferred);
amended again 2026-08-22, see
[Amendment 3](#amendment-3--2026-08-22-what-recent-means-for-a-source-with-no-date-at-all)

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

## Amendment 2 — 2026-08-17: per-source recovery, closing what Amendment 1 deferred

Amendment 1 named the per-source gap and deferred it: "per-source recovery
windows would need per-source success tracking, a bigger change than this
finding's concrete scenario... asked for — deliberately not built here."
`docs/audit/POST_REMEDIATION_CHANGE_AUDIT_2026-08-17.md` re-raised it as
PR-003 with the concrete scenario Amendment 1's text anticipated almost
exactly: one source down for days while another stays healthy, every cycle
still reporting "success."

ADR-041 closes it: `runs` gains `attemptedSources` alongside the existing
`failedSources`, and `RunsRepository.findLastSuccessfulSourceCollectAt(source)`
derives each source's own last real success from run history.
`executeCollect` computes a `cutoffForSource` per distinct source instead of
one global cutoff. The "bigger change" Amendment 1 priced in turned out to
be one column and one query method, not a new persisted concept — see
ADR-041 for the full reasoning, cost, and what remains unchanged
(`computeRecencyWindowDays` itself, and `evaluateCollectionHealth`'s
alerting, which still matters for telling a human a source is failing in
the first place).

## Amendment 3 — 2026-08-22: what "recent" means for a source with no date at all

`docs/11-known-issues.md` B1 named the gap this ADR's own "Hard" consequence
predicted: `publishedAt`-based filtering is inert for a source that never
states one, and CIEE is that source for **100% of its postings** — reaffirmed
again while writing this amendment, reading `ciee-schema.ts`'s own doc
comment: "Nothing resembling one exists on the record," confirmed across the
full 300-posting fixture sample, not assumed. There is no undiscovered field
to map; this is not a normalizer gap.

B1's earlier mitigation (2026-08-16) already closed the _scoring_ half of
the cost this ADR exists to bound: `criteria.maxAgeDays` and
`undatedBacklogCutoverAt` stop an old-by-`firstSeenAt` CIEE posting from
ever reaching Stage A/B, using the exact fallback this ADR's own "Hard"
section named as the honest option for a source that "says less." What B1
left explicitly open was collection-stage growth: "the corpus itself still
grows without limit, every CIEE posting is still collected and stored
regardless of age." This amendment is the decision B1 asked for on that
point specifically.

**Measured before deciding**, the same discipline `criteria.yaml`'s own
keyword entries already follow — queried Atlas's production database
directly (`docker exec argos-career node ...better-sqlite3...`, read-only).
CIEE's `first_seen_at`, grouped by day, since the source was enabled
(ADR-021):

```
2026-08-16   2091   -- the one-time backfill, ADR-021's initial sweep
2026-08-17    168
2026-08-18    131
2026-08-19    162
2026-08-20    113
2026-08-21     44
2026-08-22    134
```

After the one-time backfill, steady-state growth is **~100-170 rows/day**,
not an unbounded or accelerating curve — CIEE's own board evidently removes
closed postings from `vitrine-vaga/publicadas` at roughly the rate it adds
new ones, since the full sweep does not keep finding a strictly larger set
each cycle. The entire database — every source, every extraction, every
match, every event row, not just CIEE's postings — measures **44.9 MB**
(`PRAGMA page_count * page_size`) after six days of real production
operation. At the measured steady-state rate, reaching even 1 GB of
CIEE-driven growth alone is years away, on hardware ADR-020 already
established has no fixed budget and 6.1 GB free specifically because the
one workload that budget existed for was retired.

**Decision.** No new collection-stage mechanism is built. "Recent," for a
source with no publication-date signal at all, **already means** what B1's
mitigation made it mean — `firstSeenAt`, bounded by `maxAgeDays` and
`undatedBacklogCutoverAt` at the pre-filter, which is the layer that
actually spends money (Stage A/B calls) on a stale posting. Building
collection-stage pruning now — discarding or refusing to store a CIEE
posting because it is old — would be solving a storage-growth problem that
the measurement above shows does not exist yet, against a resource this
project has already decided not to budget defensively (ADR-020's own
correction: "spend it where it buys something... rather than trusting a
number written before the workload existed"). Declining to build
unmeasured mitigation for an unmeasured cost is the same discipline that
ADR-011 already applies to `criteria.yaml`'s keyword lists — a candidate
only earns a rule once it is a real, counted problem.

**Consequence — this is a decision with a real reversal trigger, not a
close-and-forget:** revisit if the database crosses **500 MB** (roughly a
10× headroom past today's measurement) or if `docker stats`/`df` on Atlas
ever shows disk pressure from any cause — whichever comes first. At that
point the honest fix is a `discardedAt` sweep keyed on `firstSeenAt` past
some large threshold (a year, not `maxAgeDays`'s much shorter scoring-
relevant window — this would be about storage, not relevance) using the
same manual-act discipline C1's `runs`-row cleanup already established:
a deliberate, logged action, not a side effect of a routine collection
cycle.

**Reversal cost:** none — this amendment adds no code, only a decision and
a documented trigger for revisiting it.

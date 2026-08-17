# ADR-034 — One append-only `posting_events` table for prefilter, score and delivery decisions

## Status

Accepted — amended 2026-08-17, see
[Amendment 1](#amendment-1--2026-08-17-collection-joins-the-covered-stages)

## Date

2026-08-17

## Context

`docs/audit/AUDIT_REPORT.md` raised two findings that turned out to be the
same missing piece seen from two angles:

- **AC-019** (MEDIUM): `applyPreFilter` returns a `reason` and `tracks`, but
  `executeDeliver` only ever kept `.passed` — the reason was computed and
  immediately thrown away. Nothing recorded _which_ rule rejected a
  posting, or against which version of `criteria.yaml`. "Why isn't this
  posting in the digest" was answerable only by re-running the pure
  function by hand against today's criteria, which is not necessarily the
  criteria that were active when the posting was actually dropped.
- **AC-027** (MEDIUM): `runs` has aggregate counts per run
  (`filteredCount`, `scoredCount`, ...) but no run↔posting relation and no
  per-source, per-reason breakdown. `normalized=0` is ambiguous between
  "source was empty," "50 items were malformed," and "the normalizer
  regressed" — the run row cannot distinguish them, and there is no way to
  ask "what happened to fingerprint X" without grepping logs.

Both point at the same gap: individual stage decisions (prefilter verdict,
score verdict, delivery) happen and are immediately discarded rather than
recorded. AC-027's "run↔posting relation" is the natural superset of
AC-019's "persist the prefilter reason" — building them as two separate
mechanisms would mean two schemas answering overlapping questions.

## Considered options

### Add reason columns to `postings` itself

Rejected: `postings` is the current-state table (`docs/05-domain-model.md`).
Every rescore or reprefilter would overwrite the previous decision, which
is exactly what AC-019 flags as a problem — no way to see that a posting
was rejected under yesterday's criteria and would pass today's.

### A full event-sourcing rebuild of `postings` state

Rejected as out of scope: this would replace `postings`'s current-state
model with a projection over an event stream, a materially bigger change
than either finding asks for, and not what the remediation plan scopes
this pass to (principle: "avoid destructive rewrites first").

### One append-only `posting_events` table, one row per (run, posting, stage) decision

Chosen. Same table serves both findings: `stage` distinguishes
`"prefilter"` / `"score"` / `"delivery"`, `outcome` carries the
stage-specific verdict (a `PreFilterRejectionReason`, a `Verdict`, or
`"failed"`/`"delivered"`), and `reason`/`criteriaHash` are optional columns
only prefilter rows populate today. `findByRun` answers AC-027's "what
happened in this run"; `findByFingerprint` answers AC-019's "why is this
posting where it is," across every run that ever touched it.

## Decision

`src/persistence/infrastructure/schema.ts` gains `postingEvents`
(migration `0014_daffy_taskmaster.sql`, additive `CREATE TABLE`, per
CLAUDE.md §12/§11's additive-migrations discipline): `id` (ULID),
`runId`, `fingerprint`, `stage`, `outcome`, nullable `reason`, nullable
`criteriaHash`, `occurredAt`. Indexed on `runId` and `fingerprint` — the
two axes both findings actually query on.

`PostingEventsRepository` (`src/persistence/infrastructure/
posting-events-repository.ts`) exposes `record`, `findByRun`,
`findByFingerprint`. No `update`/`delete` — a wrong decision is corrected
by a later row from a later run, never by editing history, matching the
append-only reasoning ADR-033 already used for Catho's checkpoint file.

`executeDeliver` (`src/cli/main.ts`) now records one event per candidate at
each of the three stages it already runs:

- **prefilter** — every posting `findUnnotified()` returns gets a row,
  passed or rejected, not only the ones that pass. `reason` is
  `applyPreFilter`'s own `PreFilterRejectionReason`. `criteriaHash` — a new
  `hashCriteria()` (`src/prefilter/domain/criteria-hash.ts`), mirroring the
  existing `hashProfile` pattern — tags the row with which criteria version
  produced it, so a later criteria edit is visible as a new decision
  instead of silently contradicting the old one.
- **score** — one row per posting that reached the scorer, `outcome` the
  `Verdict` on success or `"failed"` with the `ScoreFailureReason` on
  failure.
- **delivery** — one row per posting actually included in the digest
  (`digest.recommended` + `digest.review`), alongside the existing
  `markNotified` call.

## Consequences

**Easy:** both AC-019 ("why did this posting disappear") and AC-027 ("what
did this run actually do, source by source") are answerable with a
`findByRun`/`findByFingerprint` query instead of re-running pure functions
by hand or grepping logs. One schema, one repository, one place future
stages (Stage A/B individually, if that granularity is ever needed) would
extend rather than a second parallel mechanism.

**Hard:** the table is unbounded and append-only with no retention policy
yet — a long-running deployment will accumulate one row per posting per
stage per run indefinitely. Acceptable for now (SQLite on Atlas, personal
scale, `docs/11-known-issues.md` is where a retention/compaction story
would be recorded if usage ever justified it); this ADR does not solve it.
`criteriaHash` is only populated on prefilter rows — score/delivery rows
have no equivalent versioning today, so "which scoring config produced
this verdict" is still not directly answerable from this table alone.

**Deliberately not solved here:** Stage A/B (extraction/matching) do not
get their own event rows — the `score` stage row is one summary per
posting, not per-requirement. AC-027's "retries, cache hits" breakdown is
still answered by `runs.llmAttempts`/`llmCostUsd` (ADR from AC-015), not by
this table.

**Reversal cost:** low. `PostingEventsRepository` has no dependents outside
`executeDeliver`; reverting means dropping the three `record()` calls and
leaving the table unused (SQLite has no cheap `DROP TABLE` migration story
here, but an unused additive table costs nothing at rest).

## Amendment 1 — 2026-08-17: collection joins the covered stages

A post-remediation audit (`docs/audit`, PR-021) named collection by name
as one of the gaps this ADR's own "deliberately not solved here" section
had already flagged in spirit: "collection schema rejection, normalization
rejection, too-old collection drops... are absent." Two other stages
named in the same finding were already closed by the time PR-021 was
read — dedup's canonical/duplicate relation got its own coverage in
ADR-010 Amendment 3 (`stage: "dedup-similarity"`), landing the same day
as this amendment but as a separate, independent fix. Collection had none
at all.

**Decision:** `executeCollect` now records a `posting_events` row
(`stage: "collect"`) for every raw item that became a real `Posting` —
`outcome: "too_old"` when the recency cutoff (ADR-019) drops it, with
`reason` carrying the posting's own `publishedAt` and the cutoff it
missed; `outcome: "new"` or `"already_seen"` for every successful
`upsert`, mirroring what `wasNew` already reported at the run-count
level.

**Not covered, and not a gap in this amendment's own scope:** a raw item
that never became a `Posting` at all — no normalizer registered for its
source, or the normalizer's own rejection — has no fingerprint to key an
event on, since `posting_events.fingerprint` is `NOT NULL` and a
fingerprint is computed only once `normalize` succeeds. The run-level
`unnormalizableCount` aggregate is what represents this case, unchanged
from before this amendment.

**Still deliberately not solved, as this ADR's own Consequences section
already said and this amendment does not revisit:** Stage A/B cache
hit/miss events, and profile-hash/model/prompt identity on score rows.
PR-021 asked for both; both remain real, larger asks than one amendment
covers in one pass, the same judgment call this project has made
repeatedly this cycle for genuinely bigger asks bundled into one audit
finding (ADR-010 Amendment 3 versus full threshold calibration; ADR-043
versus full per-source/query funnel counters).

**Reversal cost:** trivial — the two new `record()` calls in
`executeCollect` are additive, same shape as the original three this ADR
already accepted the reversal cost of.

# ADR-043 — `receivedCount`/`schemaRejectedCount` are nullable, not default-zero

## Status

Accepted

## Date

2026-08-17

## Context

`runs.receivedCount`/`runs.schemaRejectedCount` exist so `collectedCount`
(raw items that passed a collector's own item schema) can be checked against
how many the source actually returned, and how many silently failed that
schema before ever becoming a candidate `Posting` — the reconciliation
`docs/audit/AUDIT_REPORT.md` AC-012 asked for. `CollectorPort`'s own
`receivedCount`/`schemaRejectedCount` fields were built optional from the
start, with a docblock stating plainly: "an absent count is honestly
'unknown,' not zero."

The persisted columns did not honor that. Both were declared
`.notNull().default(0)`, and `executeCollect` aggregated with
`received += result.receivedCount ?? 0` — collapsing "this collector could
not report it" into the same value as "this collector reported receiving
zero items." A post-remediation audit (`docs/audit`, PR-014) named the
concrete consequence: "an absent `receivedCount` contributes zero and
persists into a non-null default-zero column... one collector stops
reporting its raw total while another returns zero — both runs look
identical."

The gap was not theoretical. `executeIngestExternal` — the shared landing
point for Indeed (ADR-027) and Catho (ADR-032/033) — never had a
`receivedCount` concept at all; neither host process reports a "raw items
before schema validation" total the way `GupyCollector`/`CieeCollector`/
`SolidesCollector` do. Every external-ingest run therefore wrote `0` to
both columns by omission, forever indistinguishable from a source that
genuinely received nothing that run.

## Considered options

### Add a "completeness" boolean alongside the existing 0-default columns

Keep `receivedCount`/`schemaRejectedCount` as they are, add
`receivedCountComplete: boolean`. Rejected: two columns to keep in sync for
one fact, and every future reader has to remember to check the flag before
trusting the number — an easy mistake to reintroduce the exact bug this ADR
fixes.

### Per-source/query funnel counters in a new table

The audit's fuller recommendation: "persist nullable/completeness-aware,
per-source/query funnel counters with mutually exclusive reason codes."
Real, and named explicitly as future work below — but a materially bigger
change (a new table, one row per source per run, CIEE's own
already-controlled education/city/area drops counted separately from
schema rejection) than the concrete bug actually in the codebase today
warrants fixing in one pass. Deferred, the same judgment call ADR-010
Amendment 3 made for full similarity-threshold calibration versus its own
narrower shadow-mode fix.

### Make the columns nullable, no default (chosen)

`NULL` is exactly what "no query in this run reported a reconcilable
count" already means in `CollectorPort`'s own contract — reusing it here
costs nothing new to the schema's vocabulary. A run row that never sets
these columns (`start()` doesn't, and neither does a `finish()` call that
omits them) now reads back `NULL` for free, no code change needed in
`executeIngestExternal` at all.

## Decision

`runs.received_count`/`runs.schema_rejected_count` (`schema.ts`) drop
`.notNull().default(0)` — plain nullable integer columns, migration
`0021_mute_amphibian.sql` (a table rebuild; SQLite cannot `ALTER COLUMN`
a `NOT NULL` constraint away in place). Existing rows keep whatever `0`
they were written with — there is no way to retroactively know which of
those zeros were real and which were an unreported collector, so no
backfill is attempted.

`executeCollect`'s aggregation (`src/cli/main.ts`) changes from
`received += result.receivedCount ?? 0` to a form that goes `null` the
moment any query in the run does not report a count, and stays `null` for
the rest of the run regardless of what later queries report — a partial
sum mislabeled as complete is worse than an honest "unknown," the same
reasoning ADR-010 Amendment 3 applies to a duplicate match: silence,
not a wrong destructive answer.

`RunCounts.receivedCount`/`schemaRejectedCount` (`runs-repository.ts`)
widen to `number | null`. `CollectOutcome.received`/`schemaRejected`
(`cli/main.ts`) do the same.

## Consequences

- **The external-ingest gap closes without touching
  `executeIngestExternal`.** It never set these fields; that was always
  the bug, and a schema-only fix resolves it — `RunCounts`'s type
  widening exists for correctness at the call sites that _do_ pass real
  values, not because this path needed new code.
- **No reader currently branches on these columns** (`GET /runs`,
  `GET /runs/:runId` pass the raw row through as JSON, where `null`
  serializes correctly) — this ADR does not need to touch the API
  surface, only the schema and the one place that computes the aggregate.
- **Still aggregate, not per-source.** A run with three Gupy queries and
  one CIEE query where only CIEE fails to report still shows the whole
  run as `null`, not "Gupy: 150, CIEE: unknown." That finer breakdown is
  the deferred option above — real work, left for its own change once a
  concrete need for per-source attribution (not just per-run) appears.
- **CIEE's own business-filter drops (education level, city, area) are
  still uncounted** — a different, already-controlled kind of drop from
  schema rejection (the field's own docblock says so), and part of the
  same deferred per-source work, not this ADR's scope.
- **Reversal cost:** low. Restoring `.notNull().default(0)` is one more
  migration (another SQLite table rebuild); restoring the `?? 0` folding
  in `executeCollect` is a one-line revert with no schema implication
  either way.

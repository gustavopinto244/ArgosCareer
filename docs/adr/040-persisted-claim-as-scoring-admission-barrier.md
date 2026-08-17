# ADR-040 — A persisted, atomic claim as the scoring admission barrier

## Status

Accepted

## Date

2026-08-17

## Context

Item 4 of `docs/audit/POST_REMEDIATION_CHANGE_AUDIT_2026-08-17.md`'s
recommended fix order (§11), HIGH finding PR-004.

`executeDeliver` ran `executeDedup` (its own dedup pass) and, afterward, in a
separate read, `PostingsRepository.findUnnotified()` to select scoring
candidates. Both were real database operations, but not one atomic unit —
between dedup's commit and the candidate read, or across the whole
multi-minute scoring loop that followed, nothing stopped a _second process_
(the API server handling a Catho/Indeed/LinkedIn ingest webhook, or a second
CLI invocation) from inserting or claiming the same postings. `RunLock`
(ADR-024) already guards against two runs overlapping _within one process_,
and says so explicitly — it does not and cannot cover a second, separately
invoked process, because it is in-memory. `PostingsRepository.upsert`'s own
single-statement atomicity (ADR-024 Amendment 1) does not help either: the
gap is not any one write racing another, it is a multi-step read-then-act
sequence spanning several separate transactions with nothing tying them
together across processes.

**This is a direct reversal of a decision ADR-024 already made.** Amendment
1 examined this exact gap (raised there as AC-020) and left it deliberately
open: "no observed incident, a single-operator personal project, and real
added complexity (a `run_locks` table, lease/expiry semantics for a crashed
holder) for a risk that remains hypothetical." Two things changed since:
first, the 2026-08-17 post-remediation audit re-raised it as PR-004 with
**CONFIRMED** confidence and a concrete, non-hypothetical impact — "duplicate
OpenRouter spending and duplicate recommendations remain possible in every
concurrent entry path," not merely a theoretical race. Second, and more
directly relevant to ADR-024's own cost/benefit framing: the actual fix
turned out to need none of the machinery ADR-024 anticipated. No new
`run_locks` table, no separately-designed lease/expiry protocol — the
existing `postings` table gained two columns and the existing dedup pass
gained one more step inside the transaction it was already going to run.
The "real added complexity" ADR-024 weighed against a hypothetical risk was
larger than what closing it actually cost.

## Considered options

### Leave it as ADR-024 Amendment 1 left it — deliberately open

Rejected now, for the reasons above: the audit elevated the risk from
hypothetical to confirmed, and the actual fix is cheap. Revisiting a
decision when the facts that motivated it change is the point of writing
them down in the first place (`CLAUDE.md`: "if this file is wrong, fix it
in the same pull request that proves it wrong").

### A new `run_locks` table with lease/expiry semantics (ADR-024's original sketch)

Rejected as unnecessarily general. ADR-024's sketch imagined a lock generic
enough to guard any pipeline stage. The actual problem is narrower and
better-specified: only the _scoring candidate selection_ needs cross-process
exclusivity (collection and standalone dedup do not spend money and can
tolerate a redundant pass). A purpose-built claim on the one table that
already represents the resource being contended for (`postings`) is simpler
than a generic lock table and requires no new abstraction.

### Wrap the entire `executeDeliver` call in one long-lived transaction

Rejected. `executeDeliver` makes real network calls (Stage A/B, Telegram)
that can each take seconds and, across a real backlog, the whole run
minutes to hours. Holding a single SQLite write transaction open for that
long blocks every other writer (`collect`, external ingest) against the same
database file for the run's entire duration — trading one concurrency
problem for a worse one. The claim only needs to be atomic with the
_selection_ step; resolving it (scoring, notifying) can and should happen
outside any transaction.

### An atomic claim, scoped to dedup + candidate selection only

Accepted — see Decision.

## Decision

`postings` gains `scoring_claimed_at`/`scoring_claim_run_id` (nullable;
migration `drizzle/0018`). `PostingsRepository.claimForScoring(runId,
claimedAt, staleClaimMs)` selects every active, unnotified, undiscarded
posting that is either unclaimed or claimed longer ago than `staleClaimMs`
(default 4 hours — comfortably longer than one nightly run per ADR-009,
bounding how long a hard-crashed run's claim can strand a posting without
new sweeper infrastructure), then marks all of them claimed by `runId` in
the same call. `releaseUnresolvedClaims(runId)` clears the claim on every
posting `runId` still holds that was not, in the end, notified.

`executeDeliver` no longer calls the plain `executeDedup` + `findUnnotified`
sequence. A new `executeDedupAndClaim` wraps `dedupSimilarPostings` and
`claimForScoring` in one `db.transaction()` — `better-sqlite3` serializes
write transactions at the database-file level (the same guarantee
`PostingsRepository.upsert`'s docstring already documents, ADR-024 Amendment
1's verified claim), so any other process's own write transaction (an
`upsert` from external ingest, or a second run's own claim attempt) is fully
before or fully after this whole unit, never interleaved partway through it.
The scoring loop iterates the claimed set directly, not a fresh read.
`releaseUnresolvedClaims` runs at every exit path that does not end in
`markNotified`: the top-level catch, the notify-failure branch, and once at
the end of a successful run for whatever the notify-marking loop's
`notifiedAt IS NULL` guard left behind (prefilter rejects, discard verdicts,
recoverable failures per ADR-038, or postings never reached because a
permanent transport failure stopped the batch early per ADR-039).

## Consequences

- Closes PR-004: no posting can become eligible for paid Stage A/B scoring
  without first passing exact and similarity dedup, atomically, regardless
  of how many processes are touching the database concurrently. A
  concurrent ingest's near-duplicate is either caught by this run's dedup
  pass (if it lands before the transaction) or simply absent from this
  run's claim (if it lands after) — never both present and un-deduped.
- **This is also the fix for AC-020/PR-004's specific complaint about
  `RunLock`.** `RunLock` itself is unchanged and still valuable — cheap,
  in-process, avoids wasted duplicate work without a database round trip —
  its docstring now says plainly that the cross-process gap it always
  disclaimed is closed one layer down, not by it.
- A hard process crash (`kill -9`, not a caught exception — the try/catch
  already releases claims on every path it can observe) mid-run leaves
  claimed postings stuck for up to `staleClaimMs` before another run can
  reclaim them. Bounded, not eliminated — a deliberate trade against
  building lease-renewal/heartbeat infrastructure for a personal project's
  batch job, matching ADR-024's original cost-conscious framing even while
  reversing its conclusion on the narrower question.
- `findUnnotified()` is no longer `executeDeliver`'s own candidate-selection
  query — kept as a general-purpose "what's outstanding" read (a superset of
  what is currently claimable, since it does not consider claim state).
- **Reversal cost: low.** Two nullable columns and two repository methods
  with no other callers; reverting means deleting `executeDedupAndClaim` and
  restoring the plain `executeDedup` + `findUnnotified` sequence, with no
  migration to roll back (the columns can simply go unused).

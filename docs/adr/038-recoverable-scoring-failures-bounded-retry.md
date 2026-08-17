# ADR-038 — A scoring failure is reported, not notified, and retries up to a bounded ceiling

## Status

Accepted

## Date

2026-08-17

## Context

Item 2 of `docs/audit/POST_REMEDIATION_CHANGE_AUDIT_2026-08-17.md`'s
recommended fix order (§11), HIGH finding PR-002.

`executeDeliver` (`src/cli/main.ts`) marks every entry that appears in a
successfully-sent digest as `notified` — `[...digest.recommended,
...digest.review]`, one `markNotified` call each — and `findUnnotified`
(the candidate pool for the next run) permanently excludes anything
`notified`. A posting whose scoring failed (`ScorerPort.score` returned
`ok: false`) is not discarded — ADR-006/AC-009 already made sure of that, it
enters `digest.review` with `scoreFailureOutcome` and a `scoreFailureReason`
— but it was still marked `notified` unconditionally, exactly like a real
`apply`/`review` verdict.

The audit's real-world scenario: OpenRouter times out or returns invalid
JSON for one posting. The digest reports "não foi possível pontuar" once.
The provider recovers the next day, but the posting can never be
automatically rescored — `notifiedAt` is already set, `findUnnotified` will
never return it again, and ADR-006's own text ("a human can re-run scoring
manually") describes a path the runtime does not actually provide. A
run-wide credential or model-configuration problem is the worst case: every
posting in that run's backlog gets marked notified on its one and only
scoring attempt, and the whole backlog silently drops out of future scoring
forever.

## Considered options

### Never mark a scoring failure notified, retry it every run indefinitely

The simplest read of "a failure must remain recoverable." Rejected alone:
combined with PR-007 (permanent OpenRouter auth/model errors are not yet
batch-fatal, still open at time of writing) a single revoked API key would
turn every future nightly run into a full re-attempt of the entire failed
backlog, forever, at full model cost, until a human notices and fixes the
credential. The audit's own finding text asks for "an explicit, idempotent
retry lifecycle **with bounded policy**" — unconditional infinite retry is
not a bounded policy.

### A separate CLI/API "rescore" command, no automatic retry

Considered. Closes "no per-posting retry endpoint" literally, but does
nothing for the common case (a multi-hour provider blip) without a human
noticing and running the command — the failure would sit unrecoverable by
default, which is most of what PR-002 is about. Deferred rather than
rejected: worth adding once PR-007 makes permanent-vs-transient failures
distinguishable at the batch level, so a future explicit command can target
"give up because it's genuinely broken" postings specifically rather than
duplicating the automatic bounded retry this ADR adds. Not built here.

### Automatic retry, bounded per posting, escalating to a distinct terminal state

Accepted. A posting whose scoring fails is left `notifiedAt: null` (so it
stays in `findUnnotified`'s pool and gets a fresh attempt next run) for up to
`DEFAULT_MAX_SCORE_FAILURES` (5) consecutive failures. On the attempt that
would be the sixth, `executeDeliver` does not call `scorer.score` at all —
it synthesizes a `max_retries_exceeded` outcome, marks the posting notified,
and stops. Chosen because it is genuinely bounded (a permanently broken
posting cannot cost more than 5 attempts, ever, without a human's
involvement) while still recovering automatically from the common transient
case (a provider outage measured in hours to a few days) without anyone
having to notice and intervene. Five is not calibrated against real failure
data — it is the same ceiling this project already uses for Catho's
checkpoint quarantine (`collectors/catho/state.ts`), chosen there for the
same reasoning: enough attempts to absorb a multi-day outage, not so many
that a permanently broken item burns unbounded resources first.

## Decision

- `postings` gains `score_failure_count` (integer, default 0) and
  `last_score_failed_at` (nullable timestamp) — migration `drizzle/0017`.
- `PostingsRepository.getScoreFailureCount`/`recordScoreFailure`/
  `clearScoreFailures`: read the count before scoring, increment-and-stamp
  on failure, reset on the next success. `recordScoreFailure` uses an atomic
  `SET x = x + 1`, not read-then-write.
- `ScoreFailureReason` gains `max_retries_exceeded` — set by `executeDeliver`
  itself, before `scorer.score` is ever called, not something any
  `ScorerPort` implementation returns. `SCORE_FAILURE_LABEL`
  (`render-digest.ts`) gained the matching pt-BR line, distinct from an
  ordinary failure's, so the digest reads "this one needs a human, not
  another automatic attempt" rather than repeating the same generic message
  forever.
- `executeDeliver`'s score loop: for each filtered posting, read
  `getScoreFailureCount` first. At or above `maxScoreFailures`
  (`DEFAULT_MAX_SCORE_FAILURES = 5`, an `executeDeliver` parameter for
  testability), skip the model call entirely and synthesize
  `max_retries_exceeded`. Otherwise score normally; on success, clear the
  count; on failure, record it.
- `executeDeliver`'s notify loop: a _recoverable_ failure (any
  `scoreFailureReason` other than `max_retries_exceeded`) is reported in the
  digest but **not** marked notified — `notifiedAt` now means "this vacancy
  was evaluated," not "a message about it was sent." Every other entry (a
  real verdict, or an exhausted failure) is marked exactly as before.

## Consequences

- A transient scoring failure — the common case, a provider blip or a
  malformed-JSON hiccup — now recovers automatically within
  `maxScoreFailures` nightly runs, with no human action required. This is
  the core of PR-002, closed.
- A permanently broken posting costs at most `maxScoreFailures` model
  attempts, spread across that many runs, ever — bounded, not unconditional
  retry. After that it stops consuming model budget and is reported once,
  distinctly, as needing a human (fix the underlying problem and it will
  never be automatically retried again under this design — see the next
  point — or `discard` it).
- **Not built: an explicit manual "rescore/unnotify" command.** Once a
  posting reaches `max_retries_exceeded` and is marked notified, nothing in
  this change brings it back into `findUnnotified`'s pool — the audit's
  "explicit, idempotent retry lifecycle" is only half-closed by automatic
  bounded retry. A human who fixes a broken API key today has no supported
  way to immediately re-queue the postings that already gave up, short of
  editing the database directly. Deferred to a future change, after PR-007
  gives it something clean to target.
- **Interaction with PR-007, not yet fixed.** PR-007 documents that a
  permanent, run-wide 401/403 currently fails once per posting rather than
  aborting the batch — so today, a revoked API key still spends up to
  `maxScoreFailures` (5) full attempts _per posting_ across 5 separate
  nightly runs before any of them stop retrying, not once for the whole
  backlog. This is a real, bounded improvement over the pre-ADR-038 state
  (which had no bound at all, ever) but is not the full fix PR-007 describes
  — that remains open and is a later item in the audit's fix order.
- One more posting-level counter to keep correct: `recordScoreFailure`/
  `clearScoreFailures` must stay called from exactly the two places
  `executeDeliver`'s score loop calls them, or the ceiling silently stops
  functioning (never triggers, or triggers on stale data). Covered by
  `test/persistence/postings-repository.test.ts` (the repository methods in
  isolation) and `test/cli/main.test.ts` (the full recover-then-exhaust
  lifecycle through `executeDeliver`).

# ADR-054 — Cooperative cancellation for `scoreAndDeliver`

## Status

Accepted

## Date

2026-08-22

## Context

`docs/11-known-issues.md` C1 named a real gap: the only way to stop an
in-flight `scoreAndDeliver` run — A1's own 4–6 hour backlog estimate is the
concrete case this matters for — is to kill the container. A hard restart
orphans the run's row (`finishedAt: null` forever, until someone finds and
fixes it by hand, as C1's own two resolved rows document) and throws away
whatever partial digest was in progress, including postings already paid for
in real LLM spend.

ADR-024 already solved a related but different problem: it stops two runs of
the same kind from _starting_ at once. It says nothing about stopping one
that is already running. The two are complementary, not overlapping —
`RunLock` exists for both.

The actual operational need is narrow: an operator (or Hermes, over the same
MCP/REST boundary M9 already exposes) wants to say "stop the run that's
going" without touching the process. `collect` and `dedup` do not need this —
A1/A3's own measurements put them at minutes, not hours, and neither has a
long per-item loop an operator would ever want to interrupt mid-way.
`scoreAndDeliver`'s Stage A/B scoring loop (`executeDeliver` in
`src/cli/main.ts`) is the one place this is worth building.

## Considered options

### A persisted, cross-process cancel flag

Would let a separate CLI invocation cancel a run in the long-lived server
process. Rejected for the same reason ADR-024 rejected a persisted lock for
the analogous problem: real added complexity (a table, or a file-based
signal, with its own cleanup and staleness rules) for a cross-process
scenario that has never been the actual reported need. The real need is an
operator with API/MCP access — already the case for every other run-control
action (`collect`, `dedup`, `deliver` are all triggered exactly this way) —
not a rival CLI process. Deferred, matching ADR-024's own precedent for
scoping a guard to the problem actually observed.

### Preemptive cancellation (aborting the in-flight LLM call itself)

Stage A/B calls already carry their own timeout and `AbortController`
(`OpenRouterClient`). Wiring an external cancel signal into that abort path
would stop a run mid-call instead of only between postings — faster, but
it means a cancelled run can leave a Stage A/B call half-attempted with no
clean outcome to record (was it `timeout`, `cancelled`, or something a
future calibration read would misclassify?). Rejected: the per-posting
checkpoint this ADR chooses instead is at most one in-flight call's worth of
extra latency (Stage B is already down to ~10 s/posting after ADR-022;
Stage A is the ~20–60 s case A3 is still measuring) in exchange for never
producing an ambiguous half-attempted call.

### Cooperative, per-posting checkpoint (chosen)

`executeDeliver`'s scoring loop already has exactly the shape needed for
this: a `for (const posting of filtered)` loop that already breaks early and
still finishes cleanly on a permanent transport failure (ADR/PR-007,
`batchFatalReason`). A cancel check is the same shape — poll a flag once per
iteration, break, deliver whatever was scored, release unresolved claims,
finish the run row with an outcome that says what actually happened.

## Decision

`RunLock` (`src/scheduling/domain/run-lock.ts`) gains a second, independent
flag set alongside its existing `active` set: `requestCancel(kind)` /
`isCancelRequested(kind)`. Requesting cancellation of a kind that is not
currently active is a no-op — there is nothing running to cancel, and the
flag must never leak into a future run of the same kind. `release(kind)`
(already called in `runExclusive`'s `finally`) clears both sets together,
so a stale request can never survive past the run it was meant for.

`executeDeliver` takes a new, optional `isCancelRequested: () => boolean`
parameter (default `() => false`, so every existing caller and test is
unaffected) and polls it once per posting, at the very top of the scoring
loop — the same checkpoint granularity `batchFatalReason` already uses.
On a true reading, the loop breaks exactly like a permanent failure does:
whatever scored before that point is still composed into a digest and
delivered, `postingsRepo.releaseUnresolvedClaims` still runs so nothing
reached-but-unscored stays claimed, and the run row is finished with a new
`RunOutcome` value, `"cancelled"` — distinct from `"failed"`, because
nothing went wrong.

`RunsService.deliver()` (REST + MCP, `runs.service.ts`) passes
`() => this.runLock.isCancelRequested("scoreAndDeliver")` into
`executeDeliver`, and `SchedulerService.runScoreAndDeliverCycle` does the
same — both read the one `RunLock` instance injected via the `RUN_LOCK`
token, so a cancel request reaches whichever of the two actually holds the
lock. A new `RunsService.cancel(kind)` validates `kind === "scoreAndDeliver"`
(`BadRequestException` otherwise — `collect`/`dedup` have no checkpoint that
would ever see the flag, and accepting a request nothing reads would be
silently misleading) and that a run of that kind `isActive`
(`NotFoundException` otherwise), then calls `requestCancel` and returns
immediately — cooperative, not synchronous; the caller learns the eventual
outcome via `GET /runs/:runId`, same as any other stage trigger. Exposed as
`POST /runs/:kind/cancel` (`RunsController`) and the `cancel_run` MCP tool
(`McpController`), both thin wrappers over the one `RunsService` method
(principle 2, and the same pattern every other run-control action already
follows).

## Consequences

**What this makes easy:** stopping a real multi-hour `scoreAndDeliver` run
without killing the container — no orphaned row, no discarded partial work,
a real `cancelled` outcome future entries (A1, C1 itself) can query for. An
operator, or Hermes over the same MCP boundary M9 already built, can now say
"stop" instead of "kill and hope."

**What this does not solve:** a run killed by a container restart still
orphans its row exactly as C1 originally described — this ADR gives an
alternative to killing the process, it does not change what killing the
process does. `collect` and `dedup` still have no cancellation checkpoint at
all; if either grows a genuinely long-running loop in the future (not the
case today, per A1/A3's own measurements), it would need the same treatment
applied here, not inherit it automatically. Cancellation is cooperative and
therefore bounded by the checkpoint interval — at most one Stage A/B call's
worth of latency between a cancel request landing and the run actually
stopping, not instantaneous.

**Cost of reversing:** low. `isCancelRequested` is an additive, defaulted
parameter; removing the feature means deleting the parameter, the `RunLock`
methods, the two callers that pass the closure, and the REST/MCP surface —
no schema migration, since `outcome` was already a free-text column with no
`CHECK` constraint enforcing the old two-value set.

# ADR-024 — An in-process guard against two runs of the same kind overlapping

## Status

Accepted — amended 2026-08-17, see
[Amendment 1](#amendment-1--2026-08-17-re-examined-against-docsaudit-ac-020-decision-unchanged)
and
[Amendment 2](#amendment-2--2026-08-17-the-cross-process-gap-is-now-closed-decision-reversed)

## Date

2026-08-16

## Context

`docs/11-known-issues.md` A2 named this as latent: `SchedulerService` registers
both ADR-009 cron jobs with `onTick: () => void this.run…Cycle()` and nothing
tracked whether the previous tick was still running. M9 made it worse by
adding three more ways to start the same work — `RunsService`'s REST and MCP
stage triggers, alongside the CLI. Four independent entry points into
`executeCollect`/`executeDedup`/`executeDeliver` (principle 2's whole point),
and until now nothing stopped two of them from starting the same stage at the
same time.

This stopped being theoretical on 2026-08-16, mid-incident: the scheduled
`scoreAndDeliver` cycle was mid-run (ADR-022's fix in flight, ~6h expected)
when `POST /runs/deliver` was called manually to test a fresh build. The call
hung on an SSH timeout with no visible result, and only a direct database
check — was a new run row open? — established it had _not_ actually
double-fired. Nothing in the system made that determination for the operator;
a person had to.

**What a real double-fire would have cost**, worked through concretely
because it had almost just happened: both instances call
`postingsRepo.findUnnotified()` before either has marked anything notified,
so both get the same (or overlapping) candidate list. Both score it — wasted
LLM spend on the overlap, not corrupted state, since extraction/match caches
are idempotent upserts. Both compose a digest and call `notifier.notify()` —
**this is the real harm**: two Telegram messages, covering overlapping
postings, landing as separate sends. Both then mark their own `sent` list
notified, which is harmless (setting `notifiedAt` twice does nothing extra)
but does not undo the duplicate message already delivered. `collect`/`dedup`
overlapping is lower stakes — redundant work against an idempotent
`markDuplicate`/upsert, not a duplicate user-facing message — but guarding
all three consistently costs nothing extra once the mechanism exists.

## Considered options

### A persisted, cross-process lock (a `run_locks` table, or a SQLite advisory pattern)

Would also cover a CLI invocation racing the running server — two genuinely
separate Node processes. Rejected for now: real added complexity (lock
timeout/expiry semantics if a process dies while holding it, an extra table,
transaction handling) for a risk that has not actually happened. The
demonstrated incident was REST-triggered against the _same_ running process
the scheduler lives in; a CLI-vs-server race is a different, unobserved risk.
Stated as an explicit limitation below rather than solved speculatively.

### A guard scoped only to `scoreAndDeliver`

The demonstrated incident and the one with real user-facing cost (duplicate
Telegram sends). Rejected as too narrow: `collect`/`dedup` share the exact
same shape of risk at lower severity, and the mechanism costs the same either
way once built. Guarding all three `RunsRepository.kind` values consistently
is not more code, just more call sites using it.

### One shared, in-memory lock, keyed by run kind (chosen)

`app.module.ts` already states the constraint that makes this sufficient:
"one process, both concerns" — `SchedulingModule` and `ApiModule` (and
therefore `SchedulerService` and `RunsService`) run in the same Node process.
A `Set<string>` of in-flight kinds, shared via one DI token resolving to one
exported singleton object, needs no persistence, no expiry logic, and cannot
outlive the process — which is exactly right, since a run that dies with the
process (a crash, a restart) needs no lock to hold past that point; there is
nothing left running to protect against.

## Decision

`RunLock` (`scheduling/domain/run-lock.ts`, pure — no I/O, matching this
project's domain-layer discipline): `tryAcquire(kind)` / `release(kind)` /
`isActive(kind)` over an in-memory `Set<string>`. `runExclusive(lock, kind,
fn)` wraps a call: acquires, runs `fn`, releases in a `finally` — so a throw
out of `fn` cannot leave the lock held forever, the same shape of bug
[PR #49](https://github.com/gustavopinto244/ArgosCareer/pull/49) already
fixed once for run rows, not reintroduced here at a different layer.

One singleton instance, exported from `run-lock.provider.ts` and provided
under the same `RUN_LOCK` token in **both** `SchedulingModule` and
`ApiModule` — the two modules are siblings under `AppModule`, neither
importing the other, so sharing the literal object reference (rather than a
`useFactory` registered independently in each, which would build two
unrelated locks) is what makes `SchedulerService` and `RunsService` actually
guard against each other.

**REST/MCP**: a locked-out `collect`/`dedup`/`deliver` call throws
`ConflictException` (409) — an explicit, immediate "no, try again shortly"
for a caller (Hermes, a human) that can act on it, rather than queuing or
silently discarding the request.

**The scheduler's cron ticks**: a locked-out tick logs a warning and skips
that phase for this invocation — never a Telegram alert. A tick losing a
race to a manual call is expected and benign, not the unexpected-failure
class `evaluateDeliveryOutcome`/`evaluateCollectionHealth` exist to catch;
alerting on it would be noise trained to be ignored, which is worse than no
alert (`docs/08`'s own reasoning about silent degradation, applied to the
opposite failure mode — noisy degradation). A locked-out `collect` tick skips
its `dedup` phase and the alert check too: nothing changed for this
invocation, so there is nothing new for `evaluateAfterCollection` to find
that the next tick will not also see.

## Consequences

**Easy:** the exact near-miss that motivated this — a manual "check now" call
landing on top of the scheduled cycle — is now a fast, explicit 409 instead
of an ambiguous outcome an operator has to go verify by hand against the
database. Reversible in the cheap sense: delete the provider registrations
and the `runExclusive` call sites, nothing about run rows or the corpus
depends on the lock existing.

**Hard, stated plainly:** this protects nothing across process boundaries. A
`docker exec argos-career node dist/cli/main.js deliver` run by hand while
the server container is also running gets its own empty `RunLock` and can
still race the server's in-flight cycle — the persisted-lock option above is
the fix for that, deliberately not built until it is an observed problem
rather than a hypothetical one.

**A lock the process forgets on crash/restart is correct, not a gap**: if
the process dies mid-run, whatever it was doing dies with it — there is no
"in-flight run" left to protect against once the process holding the lock no
longer exists. The run row it left open (`docs/11-known-issues.md` C1) is a
separate, already-known problem this ADR does not claim to fix.

## Amendment 1 — 2026-08-17: re-examined against docs/audit AC-020, decision unchanged

A repository audit (`docs/audit/AUDIT_REPORT.md` AC-020, MEDIUM, confidence
LIKELY not CONFIRMED) raised the cross-process gap this ADR already names
above as a "Hard" consequence, plus a second claim: that
`PostingsRepository.upsert`'s select-then-branch "assumes a sequential
writer" and races under concurrent access.

**The second claim does not hold up.** `upsert` wraps its select and the
write it drives in one `db.transaction()` — a real SQLite `BEGIN`/`COMMIT`,
not an application-level convention — and SQLite serializes write
transactions at the database-file level regardless of how many connections
or processes are attached. A second connection's write transaction blocks
until the first commits; it does not interleave, and empirically,
`better-sqlite3` defaults `busy_timeout` to 5000ms, so a second writer waits
before failing rather than failing immediately. Verified with a real test —
two genuine connections to the same file, one holding an open write
transaction, the other's `upsert` call — not simulated
(`test/persistence/postings-repository-concurrency.test.ts`). The comment
this method carried ("safe because this repository is used by a single
sequential batch process") was accurate about the outcome but wrong about
the reason, and has been corrected to explain the real one.

**The first claim — the cross-process `RunLock` gap — still holds, and the
decision not to fix it still stands.** Nothing AC-020 raised is new
information against the reasoning already given: no observed incident, a
single-operator personal project, and real added complexity (a `run_locks`
table, lease/expiry semantics for a crashed holder) for a risk that remains
hypothetical. The distinction the corrected `upsert` comment now draws
matters here: a _single_ upsert cannot race across processes (SQLite's
transaction already prevents it), but a _multi-step pipeline_ like
`executeDeliver` — read unnotified, score over the network, notify, then
mark notified — is not one transaction, and no single-statement guarantee
covers a second process starting the same pipeline mid-flight. That gap is
real and is exactly what a persisted lock would close. It remains
deliberately unclosed, per this ADR's original Considered Options section,
until it is an observed problem.

## Amendment 2 — 2026-08-17: the cross-process gap is now closed, decision reversed

Amendment 1 left the cross-process gap open deliberately: "no observed
incident, a single-operator personal project, and real added complexity...
for a risk that remains hypothetical." Two things changed. First,
`docs/audit/POST_REMEDIATION_CHANGE_AUDIT_2026-08-17.md` re-raised the same
gap as PR-004 with **CONFIRMED** confidence (not "LIKELY not CONFIRMED," as
AC-020 was rated) and a concrete impact — duplicate paid Stage A/B scoring
via a concurrent external-ingest process, not a hypothetical race. Second,
the complexity estimate this ADR weighed against that risk turned out to be
wrong: closing it did not need a new `run_locks` table or a
separately-designed lease/expiry protocol, the two things Amendment 1 named
as the reason to defer. `PostingsRepository.claimForScoring`/
`releaseUnresolvedClaims` (ADR-040) add two nullable columns to the table
already representing the contended resource (`postings`) and one more step
inside the dedup transaction `executeDeliver` already ran. The actual cost
was a fraction of what this ADR originally priced the fix at.

**Decision reversed for the scoring-candidate-selection case specifically.**
`RunLock` and this ADR's core decision (in-memory, single-process, cheap) are
otherwise unchanged — `RunLock` still exists, still guards other stage
overlaps within one process, and is still the right tool for that. See
ADR-040 for the full mechanism and its own honestly-stated residual gap (a
hard process crash can strand a claim for up to a bounded staleness window).

# ADR-045 — Bounded incremental checkpoints, a state-file lock, and quarantine replay for Catho

## Status

Accepted

## Date

2026-08-17

## Context

ADR-033 built Catho's checkpoint state machine to fix AC-001 (nothing was
"ingested" until a confirmed 2xx) and AC-002 (a retryable failure was no
longer indistinguishable from a genuine expiration). A post-remediation
audit (`docs/audit`, PR-011 and PR-012) found two things that survived
both fixes:

**PR-011 — quarantine has no way back.** `applyPageOutcome` computed a
`PageOutcome`'s `reason` (`"HTTP 403"`, `"no response"`, `"missing or
invalid JSON-LD"`, ...) and then discarded it the moment it folded the
outcome into `CathoStateEntry` — a quarantined ID carried only
`{state, failCount}`. Worse, nothing anywhere in this collector ever
reads a quarantined entry except `needsPageFetch`, which returns `false`
for it forever. Catho's real, already-observed 403 (this collector's own
top-of-file comment: "Playwright's default headless Chromium gets the
_same_ 403 Catho gives a non-browser client") lasting five scheduled
runs would permanently quarantine every candidate hit during that
window, discoverable again only by manually editing the state file.

**PR-012 — durability is batch-level, and two processes can clobber each
other.** `saveStateAtomic` (ADR-033) is atomic against a _torn write_ —
a crash mid-write leaves the previous complete file in place — but
`collect.ts` called it only once, after the entire page-load loop and
browser shutdown. A crash at page 299 of a 300-page run lost every
accumulated outcome and payload from that run, not just the one in
flight. Separately, nothing prevented two processes — a manual run
overlapping the scheduled timer, the exact shape ADR-024's `RunLock`
exists to prevent inside the main app — from each loading their own
snapshot and each writing their own view back, one silently overwriting
whatever the other had already accumulated.

## Considered options

### Quarantine: delete the state file to force a full re-walk

Rejected — the whole reason `state.ts` exists is to make the backlog walk
incremental (`collect.ts`'s own top comment); throwing away every
`"ingested"`/`"expired"` verdict, not just the quarantined ones, to fix
one narrow class of entry is a wildly disproportionate reset.

### Quarantine: a distinct fourth state and a state-machine transition back to "unseen"

Considered, more complex than needed. `needsPageFetch` already treats an
absent entry exactly like a fresh, never-seen ID — there is no
behavioral difference to build a new transition for. Removing the entry
achieves the identical effect with less state-machine surface.

### Durability: persist after every single page

Rejected as unnecessary I/O for the size of the loss window it closes.
`saveStateAtomic` rewrites the entire state file; doing that after every
page — itself gated behind a ≥1.5s network round trip by
`requestIntervalMs` — trades a bounded, already-small loss window (at
most `checkpointEvery` pages instead of the whole run) for meaningfully
more disk churn on every single page, for no practical difference in
what a crash could lose.

### Cross-process coordination: a database-backed lock, matching `RunLock`

Rejected — this collector deliberately has no database connection at all
(ADR-032's whole point is a fully separate host-side process). Building
one just to borrow `RunLock`'s mechanism would be a heavier dependency
than the problem needs, for a single-host deployment where a plain lock
file is sufficient and matches how `saveStateAtomic` itself already
treats the filesystem as the coordination surface.

## Decision

**Quarantine reason (PR-011).** `CathoStateEntry` gains `reason?: string`,
set from the `PageOutcome`'s own `reason` on both `"retryable"` and
`"quarantined"` transitions in `applyPageOutcome` — overwritten on every
retry, not accumulated, since this answers "why did the most recent
attempt fail," not a full history.

**Quarantine replay (PR-011).** `requeueQuarantined(state, ids?)`
(`state.ts`) removes a quarantined entry from state entirely — the same
"absent means never seen" contract `needsPageFetch` already honors, so
this is forgetting the old verdict, not inventing a new state.
`ids: undefined` requeues every quarantined entry; a name that does not
exist or is not quarantined is silently skipped, reported back via
`requeued` rather than thrown. A new standalone script,
`collectors/catho/requeue.ts` (`npm run requeue -- --all` or
`npm run requeue -- <id> [id...]`), exposes it — one run, one exit, the
same shape `collect.ts` and `collectors/indeed/collect.py` already use,
run by hand once a quarantine's cause is understood to be resolved.

**Bounded incremental checkpoints (PR-012).** `collect.ts`'s page loop
now calls `saveStateAtomic` every `CHECKPOINT_EVERY` pages (env-
configurable, default 10), not only once after the loop and browser
shutdown. The existing post-loop save stays as a final flush for
whatever accumulated since the last periodic checkpoint.

**Single-writer lock (PR-012).** `acquireLock`/`releaseLock` (`state.ts`)
implement mutual exclusion via `writeFileSync(lockPath, ..., { flag:
"wx" })` — atomic creation at the filesystem level, so two processes
racing to create the same lock file can never both succeed. `main()`
acquires `${statePath}.lock` once every required env var is validated
and before `loadState`, and releases it in a `finally` wrapping the rest
of the run (factored into a new `runOnce` function so no early return
inside it has to remember to release the lock itself). A lock older than
`DEFAULT_LOCK_STALE_AFTER_MS` (30 minutes — generous against
`MAX_PAGES_PER_RUN`'s default bounding a normal run to well under that)
is treated as abandoned rather than held forever by a process that
crashed without releasing it; there is no PID-liveness check, since a PID
recorded by one ephemeral container means nothing checked from another.

**`process.exit()` → `process.exitCode` on the two remaining early exits**
(ingest network failure, non-2xx ingest response) — `process.exit()`
terminates immediately, skipping the `finally` that releases the lock;
setting `exitCode` and returning lets the lock come off cleanly on the
way out while the process still exits non-zero once the event loop
drains. `requiredEnv`'s own `process.exit(1)` is unchanged: it runs
before any lock is ever acquired.

## Consequences

- **A crash loses at most `CHECKPOINT_EVERY` pages of work**, not an
  entire run — the concrete fix for PR-012's "avoidable external
  requests, batch reprocessing" impact.
- **Two overlapping processes can no longer silently clobber each
  other's state.** The loser logs why it skipped and exits cleanly
  (principle 1: a lock conflict degrades to "nothing happens this run,"
  never a crash) rather than proceeding to race the winner.
- **Quarantine is now genuinely reversible**, closing PR-011's "deferred
  permanent vacancy loss" — a resolved Catho block or bug no longer needs
  hand-editing a JSON file on Atlas to recover from.
- **No test coverage for `collect.ts`'s own orchestration** (the
  `runOnce` split, the periodic-checkpoint call site, `main`'s lock
  acquire/release wiring) — the same pre-existing gap ADR-044 already
  named: only `state.ts`'s pure functions have unit tests
  (`state.test.ts`), which is where every genuinely new piece of logic in
  this change actually lives (`requeueQuarantined`, `acquireLock`,
  `releaseLock`, the `reason` field). Verified once by hand against the
  real sitemap during this change (state: 0 known ids, 7,327 candidates
  discovered, 300 selected for the run, lock acquired and released
  cleanly) rather than left entirely unverified.
- **Reversal cost:** low for each piece independently. The `reason` field
  is additive and optional. `requeueQuarantined`/`requeue.ts` can be
  deleted without touching anything else. The checkpoint interval is one
  constant; setting it to a number larger than `MAX_PAGES_PER_RUN`
  restores the old once-per-run behavior without removing any code. The
  lock can be dropped by deleting the `acquireLock`/`releaseLock` calls
  in `main()`; `runOnce`'s extraction is cosmetic and harmless either way.

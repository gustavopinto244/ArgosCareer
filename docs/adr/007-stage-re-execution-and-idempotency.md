# ADR-007 — Make stages re-runnable through persisted state and idempotent writes

## Status

Accepted — amended 2026-08-14, see [Amendment](#amendment--2026-08-14-upserts-must-preserve-first-sighting)

## Date

2026-08-14

## Context

Principle 2 says every stage must be independently re-runnable: scoring
already-collected postings without re-collecting is a requirement, not a nicety.

It has been stated since M0 and has had no mechanism. `docs/02-architecture.md`
asserts that each stage boundary is persisted, and a `runs` table appears once,
in a milestone table cell. Nothing says what is persisted, what makes a re-run
safe, or what "re-run the scoring" means concretely.

The requirement is real and load-bearing. M7 iterates prompts over the same 50
postings dozens of times; re-collecting on every iteration would be slow, would
send needless traffic to Gupy, and would violate the polite-collector rules.
Beyond M7, an adapter fixed on Wednesday needs to reprocess Tuesday's postings
without waiting for the next collection.

This has to be settled before M4 designs the schema, because it is a constraint
on the schema rather than a feature built on top of one.

## Considered options

### Hold the pipeline in memory and re-run from the start

Rejected. It is the simplest thing that works for a single batch and it makes
principle 2 impossible: any re-run means re-collecting. It also loses everything
when a run is interrupted.

### A workflow or job engine

Rejected. Temporal, BullMQ or similar solve this properly and cost more memory
than the entire ~150 MB budget, for a pipeline that runs twice a week on one
machine with no concurrency.

### Persist each boundary, key each stage's output by its input

Accepted. The stage boundaries already have to be persisted for other reasons —
postings for dedup, extractions and matches for caching. Making the writes
idempotent turns that existing storage into the re-execution mechanism, with no
new infrastructure.

## Decision

**Every stage reads persisted input and writes persisted output, keyed so that
writing twice is indistinguishable from writing once.**

### Stage state keys

| Stage      | Keyed by                                    | Re-running it means                                            |
| ---------- | ------------------------------------------- | -------------------------------------------------------------- |
| Collect    | `(source, sourceId)`                        | Re-fetch from the source                                       |
| Normalize  | `fingerprint`                               | Re-derive `Posting` from the retained raw payload — no network |
| Dedup      | `fingerprint`                               | Recompute; already-seen stays already-seen                     |
| Pre-filter | `(fingerprint, criteriaHash)`               | Re-apply rules; changed criteria produce a new key             |
| Score A    | `(fingerprint, promptVersion)`              | Re-extract only if the prompt changed                          |
| Score B    | `(fingerprint, profileHash, promptVersion)` | Re-match only if profile or prompt changed                     |
| Deliver    | `(runId, fingerprint)`                      | Nothing — see below                                            |

The keys are what make caching and re-execution the same mechanism. A prompt
change during M7 invalidates stage B without touching stage A, because
`promptVersion` is part of one key and not the other.

### Writes are upserts, not inserts

Every stage write is an upsert on its key. A stage interrupted halfway and re-run
produces the same state as a stage that completed, which means **a crashed run is
recovered by running it again** — no cleanup step, no partial-state repair.

### Delivery is the exception, and is guarded separately

Re-running collection is free. Re-running delivery sends a second Telegram
message, and re-notifying a posting already seen violates success criterion 2 in
`01-vision-and-scope.md`.

So delivery is guarded by a persisted `notifiedAt` per fingerprint, checked
before sending, written after. **A posting is notified at most once, ever**,
independent of how many times delivery runs.

### Runs are recorded, not just their effects

A `runs` record per execution: `runId` (ULID), kind, timestamps, outcome, and
per-stage counts. It is the audit trail for principle 2 — "what did Tuesday's run
actually do?" — and the data source for the alerts in `08-observability.md`.

### Re-running is a first-class operation

Each stage is invocable on its own against a selection of postings, from the CLI
in M4 and over HTTP in M9. Not a debugging affordance bolted on later; it is the
requirement.

## Consequences

- M7 becomes affordable: extract once, re-match and re-score across many prompt
  and weight configurations. Without this, the calibration protocol is too slow
  to finish, and calibration is the project's distinguishing criterion.
- A broken adapter is recoverable without data loss. Fix, re-run normalization
  against retained raw payloads, and Tuesday's postings flow through — no waiting
  for the next collection, no re-fetching.
- Crash recovery is free. Re-run the run.
- **Storage grows** — raw payloads, extractions and matches are all retained.
  Acceptable at this volume on SQLite, and a retention policy becomes a real
  decision if it stops being acceptable.
- **`criteriaHash`, `profileHash` and `promptVersion` must be computed
  correctly, or the cache silently serves stale results.** This is the sharpest
  edge in the decision: a stale match is worse than a missing one, because it is a
  wrong answer that looks computed (`05-domain-model.md`). These hashes need unit
  tests proving that every meaningful change moves the hash.
- The fingerprint normalizer is now doubly frozen. It was already a migration to
  change it; it is now also the key to every cached stage output.
- Every stage write costs a key lookup. Irrelevant at this volume, and it is what
  buys everything above.

## Amendment — 2026-08-14: upserts must preserve first sighting

The text above is kept as accepted. This section closes a data-loss hazard the
original decision created, found while realigning the roadmap against the
expanded product vision.

### The hazard

The decision above makes collection an upsert keyed by source and `sourceId`. A
posting re-collected daily is therefore written repeatedly under the same key.

A naive upsert overwrites the whole row, including `collectedAt`. The invariant
in `05-domain-model.md` — "`collectedAt` is set by the collector, not by the
database" — is satisfied by that, and the result is still wrong: after a week of
daily collection, every posting looks like it was found today.

**This destroys history silently and irrecoverably.** Nothing errors, no counter
moves, and the loss is invisible until someone asks a question that needs the
answer.

The questions that need it are not hypothetical. "How has the market evolved?",
"how long do internship postings stay open?", and "is this company posting
constantly or did it post once?" all depend on knowing when a posting was _first_
seen. Question 2 of `01-vision-and-scope.md` rests on this.

### Decision

A posting carries two timestamps with different write rules:

| Field         | Written               | On re-collection   |
| ------------- | --------------------- | ------------------ |
| `firstSeenAt` | Once, on first insert | **Never modified** |
| `lastSeenAt`  | Every collection      | Overwritten        |

The upsert sets `firstSeenAt` **only on insert**, never on conflict.
`lastSeenAt` is updated on every sighting. Re-running collection remains
idempotent in every respect that matters, while first sighting stays immutable.

This is a schema-level guarantee, not a convention: writing it as a database
default on insert plus an explicit exclusion in the conflict clause is what makes
it impossible to get wrong later. A unit test asserts that a second upsert leaves
`firstSeenAt` unchanged and moves `lastSeenAt`.

`lastSeenAt` also earns its keep independently — a posting that stops appearing
is a posting that probably closed, which is a cheap expiry signal for the
pre-filter that costs nothing extra to record.

### Why now, when market analysis is deferred

Market analysis lands in M10, after calibration. This amendment lands in **M4**,
with the schema.

The two timestamps are cheap to add now and impossible to backfill later. Every
day M4 runs without them is a day of history that does not exist. That asymmetry
— trivial cost now, unrecoverable loss otherwise — is the whole argument.

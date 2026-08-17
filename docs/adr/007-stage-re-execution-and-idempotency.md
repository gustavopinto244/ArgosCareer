# ADR-007 — Make stages re-runnable through persisted state and idempotent writes

## Status

Accepted — amended 2026-08-14, see [Amendment](#amendment--2026-08-14-upserts-must-preserve-first-sighting),
[Amendment 2](#amendment-2--2026-08-17-stage-as-key-was-missing-the-one-thing-that-actually-varies-its-answer),
[Amendment 3](#amendment-3--2026-08-17-neither-key-included-which-model-answered-and-stage-b-ignored-what-stage-a-actually-produced)
and [Amendment 4](#amendment-4--2026-08-17-the-corrected-keys-were-documented-but-not-actually-enforced)

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

| Stage      | Keyed by                                                             | Re-running it means                                                                     |
| ---------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Collect    | `(source, sourceId)`                                                 | Re-fetch from the source                                                                |
| Normalize  | `fingerprint`                                                        | Re-derive `Posting` from the retained raw payload — no network                          |
| Dedup      | `fingerprint`                                                        | Recompute; already-seen stays already-seen                                              |
| Pre-filter | `(fingerprint, criteriaHash)`                                        | Re-apply rules; changed criteria produce a new key                                      |
| Score A    | `(fingerprint, promptVersion, model, contentHash)`                   | Re-extract if the prompt, model or the title/description text changed (Amendments 2, 3) |
| Score B    | `(fingerprint, profileHash, promptVersion, model, requirementsHash)` | Re-match if profile, prompt, model or the requirement set changed (Amendment 3)         |
| Deliver    | `(runId, fingerprint)`                                               | Nothing — see below                                                                     |

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

## Amendment 2 — 2026-08-17: Stage A's key was missing the one thing that actually varies its answer

The Stage state keys table above states `Score A` is keyed by `(fingerprint,
promptVersion)`, "re-extract only if the prompt changed." That statement was
incomplete in a way that mattered: `fingerprint` is company+title+city only
(ADR-007's own frozen identity, by design — a description edit is not a new
posting), but Stage A's actual model input is `title` **and** `description`.
A repository audit (`docs/audit/AUDIT_REPORT.md` AC-006, HIGH, CONFIRMED)
found the gap directly: a company editing a posting's description — adding
"inglês avançado", say — left the fingerprint (and therefore the cache key)
completely unchanged, so Stage A kept serving the extraction of text that no
longer existed on the posting.

**Decision:** `hashExtractionInput(title, description)`
(`src/scoring/domain/extraction-input-hash.ts`) joins `promptVersion` as
part of Stage A's real key. `ExtractionsRepository.find`/`upsert` both take
it now; a stored row whose `contentHash` does not match — including every
row written before this column existed, which stores `null` — is a miss,
not a stale hit. The `extractions` table gained one nullable column
(`content_hash`), additive, no backfill: a legacy row simply re-extracts
once, the same cost as any other cache miss.

**Corrected key:** `Score A` is `(fingerprint, promptVersion, contentHash)`,
not `(fingerprint, promptVersion)` — the table above understated it.

**Reversal cost:** low. `hashExtractionInput` has one call site
(`StageAExtractor`); dropping the parameter and the column restores the
previous (incorrect) behavior.

## Amendment 3 — 2026-08-17: neither key included which model answered, and Stage B ignored what Stage A actually produced

Two further gaps in the same key, both from the same audit finding
(`docs/audit/AUDIT_REPORT.md` AC-007, HIGH, CONFIRMED) that Amendment 2 left
open.

### Gap 1 — `model` was not part of either key

`LLM_MODEL` is an environment variable, not a constant. Swapping it — to try
a cheaper or newer model, or because the configured one changed upstream —
left both `Score A` and `Score B`'s keys completely unchanged, so a switch
silently served extractions and matches produced by the _previous_ model as
if they belonged to the new one. This is the same shape of bug Amendment 2
fixed for `contentHash`: something that actually varies the model's answer
was missing from the cache key.

### Gap 2 — Stage B's key did not depend on Stage A's actual output

The table above always said `Score B` is `(fingerprint, profileHash,
promptVersion)`. It never included anything derived from the requirement set
Stage A produced. So a Stage A re-extraction — triggered by Amendment 2's own
`contentHash` fix, or by a prompt-version bump, or by anything else — could
change the requirements Stage B was supposed to match against, while Stage
B's cache kept serving matches computed against the _old_ requirement set,
because nothing in its key said otherwise.

Binding Stage B's key to Stage A's `contentHash` or `promptVersion` would
work only as long as every path that changes Stage A's output is accounted
for. Binding it directly to the requirement set Stage B was actually called
with removes that assumption: it does not matter _why_ the requirements
differ, only _whether_ they do.

### Decision

`hashRequirements` (`src/scoring/domain/requirements-hash.ts`) hashes the
exact `Requirement[]` passed into `StageBMatcher.match()` and joins
`promptVersion` and `model` as part of Stage B's real key. `model` joins
Stage A's key the same way `contentHash` did in Amendment 2.

`StageAExtractor` and `StageBMatcher` both take `model` as a new trailing,
**defaulted** (`"unknown"`) constructor parameter — the value `build-scorer.ts`
always passes in production is `LLM_MODEL`, unchanged; the default exists
only so the many existing test call sites that construct these classes with
positional arguments and no opinion about model identity did not need to
change. `ExtractionsRepository.find`/`upsert` and `MatchesRepository.find`/
`upsert`, by contrast, take `model` (and `requirementsHash`, for matches) as
**required** parameters — same precedent as `contentHash` in Amendment 2: the
repository layer is where cache correctness is actually enforced, so it does
not get a default to quietly paper over a caller that forgot.

A stored row whose `model` (or, for matches, `requirementsHash`) does not
match — including every row written before these columns existed, which
store `null` — is a miss. The `extractions` table gained one nullable column
(`model`); the `matches` table gained two (`requirements_hash`, `model`).
Both additive, no backfill: a legacy row re-extracts or re-matches once, the
same cost as any other cache miss.

**Corrected keys:** `Score A` is `(fingerprint, promptVersion, model,
contentHash)`; `Score B` is `(fingerprint, profileHash, promptVersion,
model, requirementsHash)` — the table above understated both.

`MatchesRepository.findAllForProfile` (the read-only aggregate scan M10 uses)
was deliberately left scoped to `(profileHash, promptVersion)` only, unchanged
— consistent with the existing precedent that aggregate scans over the corpus
don't carry per-call cache-correctness filtering; they read whatever is there
under that prompt version.

**Reversal cost:** low. `hashRequirements` has one call site
(`StageBMatcher`); dropping the parameters and the two columns restores the
previous (incorrect) behavior.

## Amendment 4 — 2026-08-17: the corrected keys were documented but not actually enforced

Amendments 2 and 3 corrected what this ADR _says_ the key is. They did not
correct what the database actually enforced: `extractions`' and `matches`'
only unique index remained `(fingerprint, promptVersion)` and
`(fingerprint, profileHash, promptVersion)` respectively —
`model`/`contentHash`/`requirementsHash` were real columns, checked by
`find()` after a row was already located, but never part of the row's
actual identity. `upsert`'s existing-row lookup used that same narrower
key, so a different model or content under the same narrower key did not
get its own row — it overwrote whatever was there. `docs/audit/
POST_REMEDIATION_CHANGE_AUDIT_2026-08-17.md` (PR-017) found this precisely:
"the persisted model does not match its documented key semantics."
Alternating `LLM_MODEL` between two calibration runs, or editing a
description and reverting it, evicted a still-valid cached answer and paid
for it again — the cost hazard this ADR's own `hashRequirements`/
`contentHash` amendments were supposed to prevent, reopened one layer down
from where they closed it.

The `findAllForProfile`/`findAllForPromptVersion` decision above — aggregate
scans "don't carry per-call cache-correctness filtering" — is also revised,
not merely re-affirmed: ADR-042 (docs/audit PR-017) removes both methods
outright rather than adding the filtering as a second, parallel
implementation of `find()`'s own compatibility check. `MarketRepository`
now reads the cache one posting at a time, through `find()` itself, so the
aggregate path is exactly as strict as the live scoring path by
construction — not a decision to leave the aggregate path weaker, but a
decision that a second, weaker path scoped to the same cache should not
exist at all.

**Decision:** `extractions_composite_identity_unique` covers
`(fingerprint, promptVersion, model, contentHash)`;
`matches_composite_identity_unique` covers `(fingerprint, profileHash,
promptVersion, model, requirementsHash)` — migration `drizzle/0020`.
`upsert`'s existing-row lookup in both repositories now matches its own
unique index exactly, so a write under a new composite key is a genuine
insert, never an overwrite of a semantically different, still-valid row.
See ADR-042 for the full reasoning, the aggregate-reader redesign, and
docs/audit PR-013's companion fix (cache rows are now validated with real
domain schemas, not `Array.isArray` alone).

**Reversal cost:** low. Reverting means restoring the narrower unique
indexes and the narrower `upsert`/`find` WHERE clauses; no data migration,
since the additive columns already exist and would simply go back to being
checked after the read rather than as part of it.

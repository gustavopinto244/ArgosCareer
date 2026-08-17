# ADR-042 — Make the extraction/match cache identity composite, and validate cached rows against real domain schemas

## Status

Accepted

## Date

2026-08-17

## Context

Item 6 of `docs/audit/POST_REMEDIATION_CHANGE_AUDIT_2026-08-17.md`'s
recommended fix order (§11): PR-017 (MEDIUM) and PR-013 (MEDIUM), the same
two tables (`extractions`, `matches`).

**PR-017.** ADR-007's Amendments 2 and 3 already corrected what Stage A/B's
cache key is _documented_ as: `(fingerprint, promptVersion, model,
contentHash)` and `(fingerprint, profileHash, promptVersion, model,
requirementsHash)`. Neither amendment corrected what the database actually
enforced — the only unique index on either table remained the narrower
`(fingerprint, promptVersion)` / `(fingerprint, profileHash,
promptVersion)`. `model`/`contentHash`/`requirementsHash` were real,
checked columns, but only checked by `find()` _after_ a row was already
located by the narrower key — `upsert`'s own existing-row lookup used that
same narrower key, so a different model or content under it did not get its
own coexisting row. It overwrote whatever was already there. Alternating
`LLM_MODEL` between two calibration runs, or editing a posting's description
and reverting it, silently evicted a still-valid cached answer and paid for
it again. Separately, `findAllForPromptVersion`/`findAllForProfile` — M10's
aggregate corpus reader — filtered only `promptVersion`/`profileHash`,
never `model`, and could not filter `contentHash`/`requirementsHash` at all
(both are per-posting facts, meaningless as a single bulk-query condition).

**PR-013.** `parseRequirements`/`parseMatches` accepted anything
`Array.isArray` was true for — `[{}]`, `[null]`, an invalid `weight`/`status`
enum, a nested `requirement` missing a field: all valid JSON, all real
arrays, none of them a real `Requirement`/`Match`. AC-031 already closed the
"not even valid JSON" corruption class; this is the next layer — structurally
valid JSON that is still domain-invalid, the realistic shape a restore or a
manual edit produces.

## Considered options

### PR-017: widen the aggregate readers to also filter by `model`, leave `contentHash`/`requirementsHash` unchecked

Rejected as incomplete. `model` is a single value, meaningful in a bulk
`WHERE` clause; `contentHash`/`requirementsHash` are per-posting facts a
bulk scan cannot filter on without either joining against live posting
content (defeating the point of a bulk scan) or accepting the exact gap
PR-017 names.

### PR-017: replace the aggregate scan with per-posting reads through the same `find()` Stage A/B already use

Accepted. `MarketRepository` already iterates active postings one at a time
to assemble `CorpusEntry[]`; reading each one's cache entry through `find()`
— the same method, same compatibility check, same code path Stage A/B's
live scoring already trusts — costs one more indexed point lookup per
posting (this project's scale makes that free) and makes the aggregate path
automatically as strict as the live path, by construction, with no second
implementation of "is this cache entry still valid" to keep in sync.
`findAllForPromptVersion`/`findAllForProfile` are removed rather than kept
as a parallel, weaker path with no other callers.

### PR-013: a stricter but still-manual shape check (e.g., check specific keys exist)

Rejected. This project already has Zod, already validates LLM output with
it (ADR-006), and already has the exact domain types (`Requirement`, `Match`)
these rows must satisfy. A hand-rolled shape check would be a second,
narrower reimplementation of validation this project has a real tool for.

### PR-013: reuse Stage A's own strict LLM-output schema (with its length/count bounds) for cache validation too

Rejected. Stage A's schema (`stage-a-extractor.ts`) additionally bounds
string lengths and array size as an _engineering safety limit_ against a
degenerate model response (docs/audit AC-017, ADR-036) — a concern about
what a fresh LLM call can produce, not about what makes a value a
structurally valid `Requirement`. A cache row already past those bounds at
write time does not need re-bounding at read time; validating cache rows
against the plain domain shape is the right scope.

## Decision

**PR-017.** `extractions`/`matches` gain composite unique indexes —
`extractions_composite_identity_unique` on `(fingerprint, promptVersion,
model, contentHash)`, `matches_composite_identity_unique` on `(fingerprint,
profileHash, promptVersion, model, requirementsHash)` (migration
`drizzle/0020`, replacing the narrower indexes). `ExtractionsRepository`/
`MatchesRepository`'s `upsert`/`find` now query by the full composite key
directly, so a write under a new composite key is a genuine insert, never
an overwrite of a different, still-valid row.

`src/scoring/domain/posting-content-hash.ts` (new) pulls
`StageAExtractor.extract`'s normalize-then-hash pipeline
(`htmlToText` → `truncateDescription` → `hashExtractionInput`) into
`normalizePostingContent`, called by both `StageAExtractor` and
`MarketRepository` — one function computing "this posting's current content
hash," not two that could drift apart. `MarketRepository.loadCorpus` gains
a required `model` parameter and now reads each posting's extraction/match
through `ExtractionsRepository.find`/`MatchesRepository.find` directly —
the same per-posting compatibility check Stage A/B's live path already
trusts — rather than the two removed bulk scans.
`executeStudyPlan`/`scripts/report-scoring.ts` thread `model` from
`process.env.LLM_MODEL` (the same env var `build-scorer.ts` reads for the
real scorer), defaulting to `"unknown"`.

**PR-013.** `RequirementSchema`/`MatchSchema` (`src/scoring/domain/types.ts`,
next to the `Requirement`/`Match` interfaces they validate) replace the bare
`Array.isArray` check in both repositories' parse functions. A row failing
schema validation is a cache miss, the same cost as invalid JSON (AC-031) or
any other miss. `StageBMatcher.match` additionally reconciles a cache hit's
match count and per-position requirement identity against the _current_
requirement list before trusting it — `requirementsHash` matching makes a
coincidental mismatch astronomically unlikely, but says nothing about a row
whose `matches` column was corrupted independently of that column (a
restore, AC-031's own scenario); a count or positional mismatch degrades to
a cache miss rather than a wrong answer or a crash.

## Consequences

- Closes PR-017: switching `LLM_MODEL` back and forth, or editing then
  reverting a description, no longer evicts a still-valid cached
  extraction/match — both variants coexist, each independently retrievable.
  M10's corpus reader is now exactly as strict as live scoring about which
  cached rows it trusts.
- Closes PR-013: `[{}]`, `[null]`, an invalid enum, or a malformed nested
  requirement inside an otherwise-valid JSON array now read back as a cache
  miss instead of poisoning a scoring run or an M10 aggregate.
- **Every existing `extractions`/`matches` row with a null `model`/
  `contentHash`/`requirementsHash` (written before ADR-007's Amendments 2/3)
  remains a permanent, harmless miss** — unchanged from before this ADR,
  since `find()` already rejected a null-dimension row. The new unique
  indexes tolerate several such legacy rows coexisting under the same
  narrower columns (SQLite treats `NULL` as distinct from `NULL` for
  uniqueness), which is correct: they were already dead weight, not a
  constraint violation waiting to happen.
- `findAllForPromptVersion`/`findAllForProfile` are gone; the only caller
  (`MarketRepository`) reads through `find()` per posting instead. Any
  future caller needing "every cached extraction under X" would need to add
  it back deliberately, informed by why it was removed here — not
  rediscover the same weaker-compatibility gap.
- `scripts/report-scoring.ts` now needs `LLM_MODEL` set to see any cached
  data at all when `SCORER_ADAPTER=stub` was used for scoring (which writes
  no cache rows) — an honest reflection of "nothing was actually scored by
  a model," not a regression in the report itself.
- **Reversal cost: low.** The composite indexes and `normalizePostingContent`
  are additive and isolated; reverting means restoring the narrower indexes/
  WHERE clauses and re-adding the two bulk-scan methods, with no data
  migration either direction.

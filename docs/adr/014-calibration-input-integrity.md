# ADR-014 — Fix the inputs before spending another calibration run

## Status

Accepted — amended 2026-08-17, see
[Amendment 1](#amendment-1--2026-08-17-the-twice-yearly-staleness-actually-fixed)

## Date

2026-08-15

## Context

The first complete calibration run (ADR-013, `deepseek/deepseek-v4-flash-0731`,
16 hand-labelled postings) succeeded technically and failed substantively:
`scored = 16/16`, `parse-failure rate = 0%`, but correlation between computed
and hand score was **-0.097** and recall on the `apply` class was **0%**. A
per-posting audit of the cached extractions and matches found three distinct
causes, none of them in the scoring formula:

**1. A quarter of the labelled corpus had no description at all.**
`0004_useful_daimon_hellstrom.sql` added `postings.description` with
`ALTER TABLE ... ADD COLUMN`; SQLite writes NULL into every pre-existing row,
and nothing backfilled them. Because a posting already seen is never
reprocessed, those rows stayed NULL permanently — while `raw_payload`, written
since `0000`, carried the full text all along. 129 of 523 stored postings were
affected, all 129 recoverable without a network call; 4 of the 16 labelled
ones. Stage A dutifully extracted zero requirements from them, and the
empty-category rule then scored a fisiologia internship 91 and a packaging
internship 100 against hand scores of 0.

**2. The profile could not answer the most common blocking requirement.**
Nearly every Brazilian internship posting requires "cursando <course>", often
phrased as a knockout ("a partir do 3º período"). The profile schema had
`courseStart`/`courseEnd` but no course name or institution — the course was
named only in a YAML comment — and `formatProfileEvidence` renders only
`competencies[].evidence`. Stage B may quote nothing outside that block
(ADR-005), so it answered `not_met` on every enrollment requirement, which is
usually `blocking`, capping otherwise-viable postings at 35. Voke (hand 90)
scored 26, Flamengo (hand 90) scored 9.3, Bemobi Dados (hand 90) scored 27.7.
`computeAcademicPeriod` — written, tested, and correct — was called by nothing.

**3. Two thirds of evidence quotes failed to resolve to a competency.**
The prompt renders evidence as `- [Competency] text`; the model quotes back
what it was shown, tag included. `matchedCompetencyNames` looked the quote up
by exact string against the untagged profile line, so 15 of 22 quotes resolved
to nothing, silently emptying `recommendedVariant` and polluting `highlights`
with the tag. This affects question 3 of `01-vision-and-scope.md`, not the
score.

A calibration run is repeated once per configuration by design. Spending
another one against inputs already known to be broken measures the inputs, not
the configuration.

## Considered options

### Re-run calibration first, investigate after

Rejected. Every one of the three causes was already identified and none is a
tuning question — re-running would reproduce the same -0.097 at the same token
cost and answer nothing.

### Change the scoring formula so contentless postings stop scoring 91

Rejected, and worth recording why. This looks like the obvious bug, but
`docs/04-scoring-model.md` §"Low confidence" already anticipated it
explicitly: it keeps the empty-category rule, adds `lowConfidence`, and caps
the verdict at `review` so a vague posting is neither top-ranked nor silently
discarded. The 91 is a documented decision, not an oversight. The real defect
was that those postings were contentless for a recoverable reason — fix the
data, and the rule behaves as designed. Changing a documented scoring decision
to compensate for a data bug would have hidden the data bug.

The tension it leaves is real and unresolved: a `lowConfidence` posting's score
is by design not comparable to a hand score, yet it is currently averaged into
the correlation like any other. Whether the calibration report should exclude
or segment them is a genuine open question, deferred rather than answered here.

### Put enrollment in the profile as one more hand-written competency evidence line

Rejected. It would work immediately and rot immediately: a literal "2º período"
in `profile.yaml` is exactly the hardcoded period `CLAUDE.md` §9 warns "silently
ages into a lie". Deriving it wires up the function already written for this.

### Batch all of a posting's requirements into one stage B call

Deferred, not rejected. It would cut round trips roughly tenfold. But
`prompts/stage-b-matching.v*.md` chose per-requirement calls deliberately — "a
narrow, checkable judgment is what a small model is good at; a holistic one is
not" — and `OllamaScorer` on a small local model is still the production
target (`CLAUDE.md` §14). Changing call granularity mid-calibration would also
change what is being calibrated. Revisit if per-run cost proves to matter, with
the measurement now available to decide it.

## Decision

Four changes, all to the inputs and none to the scoring formula:

- **`0007_description_backfill.sql`** recovers `description` from
  `raw_payload` for every row missing it, then drops the empty stage A
  extractions and orphaned stage B matches those rows produced, so the caches
  cannot keep serving answers derived from absent text. Idempotent.
- **`courseName` and `institution` become required profile fields**, and
  `formatProfileEvidence` prepends an `[Academic enrollment]` line derived
  through `computeAcademicPeriod` — the period is computed from
  `courseStart`, never written down.
- **`StageAExtractor` returns an empty extraction without calling the model**
  when a posting has no description, and deliberately does not cache it, so a
  posting whose text arrives later re-extracts instead of being permanently
  answered from an empty cache entry.
- **`OpenRouterClient` accumulates usage** (calls, prompt/completion tokens,
  cached prompt tokens, cost) and the calibration script prints it, so what a
  configuration costs — and whether ADR-013's cache reorder is actually being
  hit — is measured rather than assumed.

## Consequences

- Stage B's cache is fully invalidated by the profile change (`profileHash`
  covers the new fields), so the next run re-matches all 16 postings. Stage A's
  cache survives for the 12 postings that had text, so extraction is only
  re-paid for the 4 recovered ones. That is the minimum spend that can produce
  a meaningful number, and it is now printed rather than guessed at.
- The next calibration therefore changes several variables at once — model,
  prompt version, profile content, corpus completeness — which breaks the
  protocol's "one variable at a time" rule. Accepted deliberately: the -0.097
  baseline measured broken inputs, so there is no baseline worth holding
  constant. From the next run onward, the rule applies again.
- The derived enrollment line changes at each semester boundary while
  `profileHash` does not, so cached matches keep whatever period was current
  when they were written. Twice a year, stage B's cache is stale in that one
  field until the profile or prompt version changes. Documented in
  `prompts.ts` rather than solved; solving it means putting a clock into the
  cache key, which is a worse trade than a twice-yearly staleness.
- `profile.yaml` files predating this ADR fail validation until `courseName`
  and `institution` are added. Intentional — a silent default would reintroduce
  exactly the `not_met`-on-everything failure this fixes.
- Backfilling from `raw_payload` is only possible because ADR-007 stored it.
  This is the second time that decision has paid for itself; worth remembering
  before anyone proposes dropping the column to save space.

## Amendment 1 — 2026-08-17: the twice-yearly staleness, actually fixed

This ADR's own Consequences named the gap and rejected the fix at hand:
"solving it means putting a clock into the cache key, which is a worse
trade than a twice-yearly staleness." A repository audit
(`docs/audit/AUDIT_REPORT.md` AC-018, MEDIUM, CONFIRMED) pointed out that
the stated mitigation does not actually hold: "twice a year... until the
profile or prompt version changes" implies the staleness self-corrects,
but nothing does that automatically. `hashProfile` never changed at a
semester boundary on its own, so a cached match written the day before one
kept answering with the old period _indefinitely_, not for a bounded
twice-yearly window — until a human happened to edit the profile or bump
the prompt version for an unrelated reason. The real scenario named: a
candidate crosses into eligibility for a `blocking` requirement mid-cycle
and stays capped at 35 for months because nothing forced a re-match.

**Decision:** `hashProfile` (`src/profile/domain/profile-hash.ts`) now
takes `today` and folds `computeAcademicPeriod`'s result into the hash —
not the raw date this ADR's Consequences warned against. The distinction
matters: a raw clock in the cache key invalidates continuously, which
really would be the bad trade this ADR called out. `computeAcademicPeriod`
is already the same discrete, twice-yearly-changing signal
`formatAcademicEvidence` uses to decide what text to render — hashing its
_result_ reproduces exactly the cadence this ADR wanted (one invalidation
per real semester boundary), just triggered by the actual event instead of
depending on an unrelated, un-guaranteed profile/prompt edit.

**Consequence:** M10's `MarketRepository.loadCorpus` (read-only) degrades
gracefully across a boundary — a posting whose cached match falls under
the old hash simply shows as not-yet-matched under the new one, the same
"explicit miss over silently wrong" reasoning the rest of this cache
already follows, not a crash or a wrong verdict.

**Reversal cost:** trivial — `hashProfile`'s `today` parameter is
optional and defaults to `new Date()`; dropping the `computeAcademicPeriod`
fold restores the exact previous behavior with no schema or migration
involved (`profileHash` is computed at read time, never stored as its own
column).

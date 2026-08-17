# ADR-005 — Keep score computation out of the LLM

## Status

Accepted — amended 2026-08-16, see
[Amendment 1](#amendment-1--2026-08-16-the-illustrative-weights-are-stale)
and
[Amendment 2](#amendment-2--2026-08-17-the-verbatim-quote-requirement-actually-enforced)

## Date

2026-08-14

## Context

The system must rank internship postings by how well a master profile matches
what each posting declares it wants. Ranking quality is the product: a digest
ordered badly costs more time than no digest, because it has to be read to be
distrusted.

Two constraints shape the design. The production scorer target is a ~4B model
running on a mini PC with no GPU and a ~250 MB peak application budget. And
criterion 6 of the project requires calibration — measuring the scoring system
against 50 hand-labelled postings and publishing the result — which is only
possible if scores are comparable across configurations.

## Considered options

### Send resume plus posting, ask for a score from 0 to 100

Rejected, on three grounds.

_Not calibrated._ Asked for a 0–100 score, models put almost everything between
65 and 85. The output has the shape of a score without the discriminating power
of one, and ranking by it approaches ranking by noise.

_Not comparable across prompt versions._ Change a sentence in the prompt and
every number moves. There is no way to tell an improvement from a shift, which
makes the calibration protocol unrunnable — and calibration is what separates
this from an aggregator with a number attached.

_Worst case for a small model._ Holistic numeric judgment is precisely where a 4B
model diverges most from a large one. Building the design around the task the
production model is worst at is a choice to fail.

### Ask the LLM for a structured verdict, compute nothing

Rejected. It moves the problem without solving it: `apply | review | discard`
straight from the model is still an uncalibrated holistic judgment, just with
fewer possible values to hide the imprecision in.

### Extract and match with the LLM, compute the score in code

Accepted. The LLM is given only the two tasks it is genuinely good at — pulling
structure out of prose, and judging one narrow claim at a time against cited
evidence. Arithmetic happens in a pure function.

## Decision

Three stages.

**A — Extraction (LLM).** Returns `{text, category, weight}` per requirement,
`weight ∈ {blocking, mandatory, desirable}`. Cacheable per posting.

**B — Matching (LLM).** Per requirement, `met | partial | not_met`, with a
**mandatory verbatim evidence quote** from the profile. `evidence: null` forces
`not_met`, enforced in code after parsing rather than requested in the prompt.
Cacheable per (posting, profile hash).

**C — Score (code).** Pure, deterministic, no I/O, unit-tested:

```
score = 65 × mandatoryCoverage + 20 × desirableCoverage + 15 × trackAlignment
```

A failed `blocking` requirement caps the score at 35, `partial` included, because
a knockout question is binary. Fewer than `minExtractedRequirements` extracted
sets `lowConfidence` and caps the verdict at `review`.

The evidence requirement is the load-bearing part. Without it the model
hallucinates adherence: it wants to agree that the candidate qualifies, and with
no obligation to point at anything it will. Requiring a quote turns an agreeable
judgment into a retrieval task with a checkable answer.

Full formula, thresholds and calibration protocol: `docs/04-scoring-model.md`.

## Consequences

- Scores are deterministic and comparable across model, prompt and weight
  changes. Calibration becomes possible, and so does changing one variable at a
  time.
- Stage C is testable with no LLM, no network and no fixtures, so it can be built
  in M1 before any model integration exists.
- Two LLM calls per posting instead of one, which costs more tokens and more
  local inference time. Mitigated by per-stage caching: stage A results survive
  every prompt iteration on stage B, which is most of the M7 workload.
- Every failure becomes attributable. A wrong score traces to a specific bad
  extraction or a specific bad match, both inspectable, rather than to an opaque
  number.
- The evidence quotes are reusable output: they are what `criticalGaps` and
  `missingTerms` are derived from, and they make the digest explain itself.
- The system now depends on stage A extracting sensible requirements. A posting
  whose text is an image, a link, or pure boilerplate yields nothing to match —
  which is the second reason `lowConfidence` exists.
- Reversing this is cheap in code and expensive in credibility: the calibration
  table published in the README would no longer mean anything.

## Amendment 1 — 2026-08-16: the illustrative weights are stale

The Decision section above states `score = 65 × mandatoryCoverage +
20 × desirableCoverage + 15 × trackAlignment` as a worked example. Those
specific numbers changed to `35 / 20 / 45` in
[ADR-026](026-recalibrate-toward-track-fit.md) — the architectural decision
this ADR records (score computed in code, not the LLM; three stages; the
mandatory evidence quote) is untouched, only the illustrative numbers are
no longer current. `docs/04-scoring-model.md` and `config/criteria.yaml`
are the authoritative current values, as this ADR's Decision section already
said before this amendment ("Full formula, thresholds and calibration
protocol: `docs/04-scoring-model.md`").

## Amendment 2 — 2026-08-17: the verbatim quote requirement, actually enforced

This ADR's own Decision section states the requirement plainly: Stage B
needs "a **mandatory verbatim evidence quote** from the profile." What
was actually enforced, until now, was narrower: `evidence: null` forces
`not_met`. Any _non-null_ string — including one the model invented
outright, possibly under a prompt-injected instruction in the posting
text this ADR's own reasoning names as the threat model — passed straight
through and counted toward `mandatoryCoverage`. A repository audit
(`docs/audit/AUDIT_REPORT.md` AC-008, HIGH, CONFIRMED) found the gap
between what this ADR claims and what the code checks, and `SECURITY.md`
made the same claim just as unenforced.

**Decision:** `isKnownProfileEvidence`
(`src/scoring/domain/evidence-provenance.ts`) checks a `met`/`partial`
evidence quote against every real evidence line in the profile
(tag-stripped, exact match — no fuzzy matching, deliberately, since a
quote that is merely _close_ to a real line is exactly as unverifiable as
one invented outright). `StageBMatcher` runs this check on every model
response before calling `createMatch`; a quote that fails it is treated
exactly like `evidence: null` — coerced to `not_met`. The same index now
backs `recommendation.ts`'s existing reverse lookup too, so both consumers
of "is this evidence real" agree by construction.

**Consequence:** the verbatim-quote requirement this ADR always claimed is
now actually load-bearing. A prompt-injection attempt that returns
syntactically valid JSON with fabricated evidence no longer manufactures a
`met` — it degrades to `not_met`, the same outcome a genuine gap in the
candidate's profile would produce. This closes AC-008's real-world
scenario without adding a new LLM call, a new cache dimension, or any
change to the prompts themselves — the check runs entirely against data
this project already trusts (the profile) and already has in memory.

**Reversal cost:** low. `isKnownProfileEvidence` has one call site
(`StageBMatcher`); removing it restores the previous (incorrect)
behavior with no schema or cache-key change.

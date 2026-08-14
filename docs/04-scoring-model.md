# 04 — Scoring model

The core component. This document explains not just how the score is computed but
why it is computed this way, because the design exists to avoid a specific
failure that the obvious approach walks straight into.

## What the system actually compares

**The master profile** against **the requirements the posting declares.**

Not against the job. Not against what the recruiter is really looking for. Not
against Gupy's internal ranking. The declared text, and nothing more. Everything
below inherits that limit — see _Honest limits_ at the end.

## Why the LLM does not produce the score

The obvious implementation is to send resume + posting to a model and ask for a
score from 0 to 100. It fails for three reasons.

**It is not calibrated.** Ask a model for a 0–100 score and almost everything
lands between 65 and 85. The output has the shape of a score without the
discriminating power of one; ranking by it is close to ranking by noise.

**It is not comparable across prompt versions.** Change a sentence in the prompt
and every number shifts. There is no way to tell whether a scoring change was an
improvement, which makes calibration impossible — and calibration is criterion 6
of the project.

**Holistic numeric judgment is the worst case for a small model.** It is
precisely where a 4B model diverges most from a large one. Since the production
target is a 4B model on a mini PC with no GPU, building the design around the
task small models are worst at would be a choice to fail.

The fix is to give the LLM only the two jobs it is genuinely good at —
**extracting structure from text** and **judging one narrow claim at a time** —
and to compute the number in code.

Recorded as ADR-005.

## Three stages

### Stage A — Extraction (LLM)

Reads the posting, returns structured requirements:

```ts
type Requirement = {
  text: string; // the requirement, as the posting states it
  category: string; // e.g. "language", "education", "tooling"
  weight: "blocking" | "mandatory" | "desirable";
};
```

**Cacheable per posting** — a posting's requirements do not change. This matters
during M7, when prompts for stage B get iterated dozens of times over the same 50
postings.

### Stage B — Matching (LLM)

For each requirement independently: `met | partial | not_met`, **with a mandatory
evidence quote from the profile.**

```ts
type Match = {
  requirement: Requirement;
  status: "met" | "partial" | "not_met";
  evidence: string | null; // verbatim quote from the profile
};
```

**The evidence quote is the load-bearing part of this design.** Without it the
model hallucinates adherence — it _wants_ to agree that the candidate qualifies,
and asked "does this person meet this requirement?" with no obligation to point
at anything, it will say yes. Requiring a verbatim quote converts an agreeable
judgment into a retrieval task with a checkable answer.

**`evidence: null` forces `not_met`.** Enforced in code after parsing, not
requested politely in the prompt. A model that returns `met` with no evidence is
returning an invalid result, and the code treats it as such.

**Cacheable per (posting, profile hash).** The profile hash is what makes the
cache correct: editing the profile must invalidate every match that used it.

### Stage C — Score (code)

A **pure function**. No I/O, no LLM, deterministic, unit-tested. Same inputs, same
number, forever. This is what makes the M7 calibration meaningful: when the score
changes, it is because the inputs or the weights changed, never because the model
had a different day.

Stage C is built in M1, before any LLM exists in the project, precisely because it
does not need one.

## The formula

```
statusWeight = { met: 1.0, partial: 0.5, not_met: 0.0 }

coverage(category) = Σ statusWeight(match.status) / count(requirements in category)

score = 65 × mandatoryCoverage
      + 20 × desirableCoverage
      + 15 × trackAlignment
```

**Empty category → coverage 1.** A posting that lists no "nice to haves" must not
score worse than one that lists them and has them met.

### `trackAlignment`

This term answers "is this the _kind_ of job I am looking for?", which is
separate from "do I meet its requirements?". A posting can match every stated
requirement and still be the wrong track — a data-analysis internship whose
requirements happen to be SQL and Python is a good match and a bad target.

**The posting's track is classified deterministically in the pre-filter**, by
keyword against a configured table, before any LLM call. Stage C then reads a
weight for that track. This keeps stage C a pure function and keeps a 15-point
term out of a small model's judgment.

```
trackAlignment = trackWeights[posting.track]
```

```yaml
# config — provisional until M7 calibration
trackWeights:
  dev: 1.0 # priority 1
  security: 1.0 # priority 1, equal to dev
  automation: 0.7 # priority 2
  unknown: 0.4
```

`dev` and `security` share the weight `1.0` because they are equal first
priorities (`01-vision-and-scope.md`). Equal priority is expressed here, in
configuration, rather than as a branch in the formula.

`unknown: 0.4` is deliberately non-zero. A posting the classifier cannot place
is a classifier gap, not a bad posting, and zeroing 15 points on a classification
failure would hide the gap by pushing the posting out of the digest. A run
producing many `unknown` postings is a signal to extend the keyword table.

**When a posting matches more than one track, the highest weight wins.** A
"DevSecOps intern" posting hitting both `security` and `automation` scores 1.0.
Averaging would penalize breadth, which is the opposite of the intent.

The weights are configuration and provisional, like every other number on this
page. Changing search strategy — adding a track, reweighting one — must not
require touching the application (principle 3).

### Blocking requirements override everything

If any `blocking` requirement fails, the score is **capped at 35** and
`blockingFailure` records which one.

**`partial` also blocks.** An ATS knockout question is binary — "are you enrolled
from the 3rd period onward?" has no half answer. A `partial` on a blocking
requirement means the model was unsure, and unsure is not a pass.

The cap is a cap, not an assignment: a posting scoring 20 that also fails a
blocking requirement stays at 20. The cap only prevents a blocked posting from
outranking a viable one.

### Low confidence

Not in the original design; added because the formula has an edge case that would
otherwise put the worst postings at the top of the digest.

A posting that lists no mandatory requirements gets `mandatoryCoverage = 1` from
the empty-category rule, and therefore scores 65 + 20 + trackAlignment ≈ 85 →
`apply`. So a vague, contentless posting outranks a detailed one that the profile
genuinely matches. The empty-category rule is right in general and wrong here.

The fix keeps the rule and adds a confidence signal:

```
if (extractedRequirements.length < minExtractedRequirements) {
  lowConfidence = true;
  verdict = min(verdict, "review");   // never "apply"
}
```

A vague posting therefore surfaces for manual review with the reason attached,
instead of either topping the ranking or being silently discarded. The threshold
is configuration, calibrated in M7 like every other threshold on this page.

This also catches a second case worth catching: stage A failing to extract
anything useful from a posting whose text is an image, a link, or boilerplate.
Both causes deserve the same treatment — a human look.

### Verdict

| Score | Verdict   |
| ----- | --------- |
| ≥ 70  | `apply`   |
| 45–69 | `review`  |
| < 45  | `discard` |

**Every weight and cutoff on this page is provisional until the M7 calibration.**
The numbers are a starting hypothesis with a defensible shape, not a result.

## Additional output

The score is what ranks the digest. These two fields are what make the system
useful beyond ranking.

### `criticalGaps`

Mandatory or blocking requirements that were not met. Accumulated across weeks,
this becomes a study backlog **prioritized by real market demand** rather than by
guesswork — if 30 of 40 back-end internships in Rio require SQL competence the
profile cannot evidence, that is a measured fact about what to learn next.

### `missingTerms`

A term present in the posting and absent from the profile **even when the
requirement is met under a different name.** The posting asks for "CI/CD"; the
profile says "GitHub Actions". Stage B correctly returns `met` with evidence, and
the score is right — but a keyword-matching ATS would never see it.

This feeds resume tailoring before applying, and it is deliberately separate from
`criticalGaps`: one is "I need to learn this", the other is "I need to say this
differently".

### `recommendedVariant` and `highlights`

Question 3 of `01-vision-and-scope.md` — "how should I present my profile for
this posting?" — is answered here, and it is nearly free because everything it
needs already exists.

`recommendedVariant` picks the resume variant whose emphasized tracks and
competencies overlap most with the posting's matched requirements.
`highlights` names the profile evidence to foreground, drawn from the matches
that scored `met` on `mandatory` or `blocking` requirements.

**Both are pure functions over data stage B already produced.** No extra model
call, no generated text, nothing invented — the system selects and ranks material
that is already in the profile. That constraint is not a limitation to work
around; it is what keeps the recommendation trustworthy.

Together with `missingTerms`, these three fields are the whole of question 3 in
v1. Writing prose — resumes, cover letters, recruiter messages — is Phase 3.

## Calibration protocol — M7

Mandatory before any weight is treated as settled. Without it, the formula is an
opinion with arithmetic attached.

1. **Label 50 real postings by hand** with the score I would give them. Do this
   before looking at any model output, to avoid anchoring.
2. **Measure** correlation between computed and hand-labelled scores, plus
   precision and recall of the verdict — with attention to recall on `apply`,
   since a missed good posting costs more than a reviewed bad one.
3. **Change one variable at a time.** Model, prompt, weights, cutoffs — never two
   at once, or the result is uninterpretable.
4. **Publish the table in the README**, including the configurations that lost.

Stage A caching is what makes step 3 affordable: 50 postings extracted once, then
re-matched and re-scored across many configurations.

The set of 50 labelled postings is itself personal data and stays gitignored; the
aggregate results are what get published.

## Honest limits

**This does not simulate any specific ATS.** Gupy ranks candidates with a
proprietary, opaque system. No external project reproduces it, and claiming to
would be a lie that is trivially checked.

What the system answers reliably:

> Does my resume demonstrate evidence for what this posting declares it wants?

Do not promise more than that in the README, in a commit message, in the digest,
or in an interview.

Further limits worth stating plainly:

- **Postings lie by omission.** Boilerplate gets copied between roles and real
  requirements surface in the interview. The system scores declared text.
- **A high score is not an interview.** It means the profile is worth submitting,
  which is exactly as much as the system was built to determine.
- **A `discard` is not proof of a bad fit** — it is a decision to spend the ten
  weekly minutes somewhere else.

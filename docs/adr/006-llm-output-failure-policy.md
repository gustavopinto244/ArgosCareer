# ADR-006 — Treat invalid LLM output as a normal outcome, not an exception

## Status

Accepted

## Date

2026-08-14

## Context

Stages A and B send a prompt to a language model and expect structured JSON back.
The production target is a ~4B model running locally on a GPU-less mini PC.

Small models return malformed output regularly, not rarely: truncated JSON,
prose wrapped around the JSON, markdown fences, trailing commas, invented enum
values, a missing `evidence` field, or a plausible-looking object with the wrong
shape. This is the normal operating condition, not an error path.

Until now the project had no answer for it. `docs/02-architecture.md` gives
collectors an explicit failure contract — `CollectionResult` with `error` set —
but scoring had nothing equivalent, and the stack decision to validate LLM output
with Zod said what detects the problem without saying what happens next.

The question has to be settled before M1, because the answer changes the
signature of `ScorerPort`, which M1 defines.

Two constraints shape it. A batch runs unattended on a schedule, so nothing can
block on a human. And principle 1 — a broken source degrades the digest rather
than cancelling it — applies here by analogy: a posting that cannot be scored
must not take the Friday digest down with it.

## Considered options

### Throw on invalid output

Rejected. It makes one bad posting fail an entire batch, contradicting the
principle that already governs collectors. It also loses the postings already
scored in that run.

### Retry until valid

Rejected. Unbounded retries against a local model with no GPU is an unbounded
time cost, and the failure mode of a model that cannot produce the shape is
usually deterministic — the same prompt returns the same broken output. Retrying
forever converts a bad posting into a hung batch.

### Repair the output in code

Rejected as a primary strategy. Stripping markdown fences and trimming to the
outer braces is cheap and safe, so it stays as normalization _before_ parsing.
But inferring intent from a malformed object — guessing which enum was meant,
filling in a missing `evidence` — manufactures data the model did not produce.
That is exactly the hallucinated adherence ADR-005 exists to prevent.

### Bounded retries, then a typed failure result

Accepted. Consistent with how collectors already fail, bounded in time, and it
keeps an unscoreable posting visible rather than silently dropped.

## Decision

**Normalize, then validate, then retry a bounded number of times, then fail as a
value.**

1. **Normalize before parsing.** Strip markdown fences and surrounding prose,
   trim to the outermost JSON object. Lossless and shape-preserving only — no
   field invention, no enum guessing.
2. **Validate with Zod.** The schema is the contract. Stage B additionally
   enforces the ADR-005 rule in code: `evidence: null` forces `not_met`,
   regardless of what the model returned.
3. **Retry on validation failure**, up to a configured maximum (default 2
   retries, 3 attempts total). The retry prompt includes the validation error, so
   the model is told what was wrong rather than asked again identically.
4. **After the last attempt, return a typed failure**, never throw:

   ```ts
   type ScoreResult =
     | { ok: true; score: number; verdict: Verdict /* … */ }
     | { ok: false; reason: ScoreFailureReason; attempts: number };
   ```

5. **A posting that fails scoring is not discarded.** It carries
   `lowConfidence` into the digest's review section with the reason attached, on
   the same grounds as a posting with too few extracted requirements: the system
   could not judge it, so a human should.
6. **A run records its failure rate.** Scoring failures are counted per run and
   surfaced in the digest's run summary.

Retry counts and the failure-rate alert threshold are configuration.

## Consequences

- One bad posting costs a bounded amount of time and never fails a batch.
- Failures are visible in two places — the posting appears for review, and the
  run summary carries the count — so a model that has started failing broadly
  shows up as a number rather than as a quietly shorter digest.
- The failure rate becomes a **calibration metric in its own right**. M7 compares
  candidate models on accuracy _and_ on how often each produces parseable output;
  a more accurate model that fails to parse a third of the time is the worse
  choice, and this decision is what makes that measurable.
- Worst case latency per posting is multiplied by the attempt count. On a local
  model this is the dominant cost of the policy, and it is why the retry ceiling
  is low and configurable.
- `ScorerPort` returns a result type rather than throwing, matching
  `CollectorPort`. Both ports now express failure as data, which is the
  convention to follow for `NotifierPort` as well.
- Normalization is a small amount of string handling that must stay
  deliberately dumb. Every extension to it should be checked against the question
  "does this invent information?" — if yes, it belongs in the schema as a
  rejection, not in the normalizer as a fix.
- The retry prompt containing the validation error is an assumption worth
  testing: it should help a model that made a formatting mistake and will not
  help a model that cannot represent the shape at all. M7 measures whether
  attempt 2 and 3 actually recover anything, and the ceiling drops to zero if
  they do not.

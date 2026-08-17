# ADR-006 — Treat invalid LLM output as a normal outcome, not an exception

## Status

Accepted — amended 2026-08-17, see
[Amendment 1](#amendment-1--2026-08-17-rule-5-actually-delivered),
[Amendment 2](#amendment-2--2026-08-17-a-failed-posting-is-notified-only-after-exhausting-a-bounded-retry-ceiling)
and
[Amendment 3](#amendment-3--2026-08-17-the-manual-rescore-path-amendment-2-left-unbuilt-now-exists)

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
must not take that night's digest down with it.

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

## Amendment 1 — 2026-08-17: rule 5, actually delivered

This ADR's own Decision section states rule 5 plainly: "A posting that
fails scoring is not discarded. It carries `lowConfidence` into the
digest's review section with the reason attached." `ScorerPort`'s own doc
comment repeated the same promise. Neither was implemented —
`executeDeliver`'s scoring loop only ever did `if (result.ok)
scoredEntries.push(...)`; an `ok: false` result was filtered out
silently. A repository audit (`docs/audit/AUDIT_REPORT.md` AC-009, HIGH,
CONFIRMED) found the gap: the posting stayed `unnotified` forever (or
until a later run's `filtered - scored` arithmetic hinted something was
off), invisible to the actual digest a human reads.

**Decision:** `scoreFailureOutcome(reason)`
(`src/scoring/domain/types.ts`) builds a placeholder `ScoreOutcome` —
`score: 0`, `verdict: "review"`, `lowConfidence: true`,
`scoreFailureReason: reason` — for exactly this case.
`executeDeliver` pushes it into the same `scoredEntries` array a real
score would go into, so `composeDigest` buckets it into `review`
alongside genuine low-confidence postings, and `render-digest.ts` prints
a distinct "não foi possível pontuar automaticamente" line instead of the
generic low-confidence warning.

**A failed posting is still marked notified once shown.** This matches
existing digest semantics exactly — a `review`-verdict posting from a
real score is never revisited either — and it is the safer choice over
the alternative (leaving it `unnotified` so the next run retries it):
that would reopen exactly the "unbounded cost amplification across days"
half of AC-009 for any _persistent_ failure (a schema mismatch, not a
transient blip), where automatic retry can never succeed and only ever
re-spends. A human who sees the failure reason can re-run scoring
manually once whatever caused it is fixed.

**Not solved here, and this is a real limitation AC-009 also names:**
Stage B still has no per-requirement partial-progress caching — a
failure on requirement 20 of 25 still discards the 19 that already
succeeded, and a later manual re-run repeats the whole posting. Fixing
that means changing Stage B's cache unit from "the whole match list" to
"one requirement," a real redesign of `MatchesRepository`'s key shape
(`(fingerprint, profileHash, promptVersion)` → something requirement-
scoped), deliberately deferred rather than folded into this fix.

**Consequence:** `evaluateDeliveryOutcome`'s `scoreFailureRateThreshold`
alert is unaffected — `scoredCount` is only ever incremented on a real
`ok: true` result, so a failed-but-now-visible posting still counts
toward the failure rate exactly as it did before this fix, just no
longer invisible to the human reading the digest.

**Reversal cost:** low. `scoreFailureOutcome` has one call site
(`executeDeliver`); removing it restores the previous (silently
discarding) behavior, no schema or cache-key change.

## Amendment 2 — 2026-08-17: a failed posting is notified only after exhausting a bounded retry ceiling

The text above is kept as originally accepted. This section reverses one
specific decision — "a failed posting is still marked notified once shown"
— not the rest of this ADR (the placeholder `ScoreOutcome`, the digest
section it lands in, the distinct failure line).

`docs/audit/POST_REMEDIATION_CHANGE_AUDIT_2026-08-17.md` (PR-002, HIGH)
found the consequence of the original decision in practice: marking every
failure notified made a _transient_ failure exactly as permanent as a
persistent one, and named this ADR's own text as documenting a manual
re-run path ("a human who sees the failure reason can re-run scoring
manually") the runtime never actually provided. The concern this ADR raised
against unconditional retry — "unbounded cost amplification across days"
for a persistent failure — was real and remains real; it was the choice
between "retry forever" and "never retry" that was wrong, not the concern
itself.

ADR-038 resolves both sides at once: a failure is left unnotified (so
`findUnnotified` picks it up again) for up to `DEFAULT_MAX_SCORE_FAILURES`
(5) consecutive runs, bounding exactly the cost amplification this ADR
warned about, then marked notified with a distinct `max_retries_exceeded`
reason once that ceiling is reached — never retried unconditionally, never
permanently lost on one blip either. See ADR-038 for the full mechanism,
its interaction with PR-007 (still open), and what remains unbuilt (an
explicit manual rescore path for a posting that has already exhausted the
ceiling).

## Amendment 3 — 2026-08-17: the manual rescore path Amendment 2 left unbuilt now exists

A post-remediation audit (`docs/audit`, PR-024) checked this ADR's own
text — "a human who sees the failure reason can re-run scoring
manually" — against the runtime and confirmed Amendment 2's own closing
sentence: no such operation existed. A posting that exhausted
`DEFAULT_MAX_SCORE_FAILURES` was marked notified with
`max_retries_exceeded` and then permanently excluded from
`findUnnotified`/`claimForScoring` (`notifiedAt`'s "write once, never
cleared" discipline, ADR-007) — recoverable, in practice, only by manual
database surgery.

**Decision:** `PostingsRepository.rescore(fingerprint)` clears
`notifiedAt`, `scoreFailureCount`, `lastScoreFailedAt`, and the scoring
claim fields for one posting, conditioned on `scoreFailureCount > 0` — a
posting whose most recent scoring outcome was a failure, the exact case
this ADR's text always claimed was recoverable. A posting whose last
attempt succeeded is never eligible, so `notifiedAt`'s write-once
discipline stays intact for every posting a human actually saw a real
verdict for; this is a scoped, deliberate exception for the one case that
discipline was never meant to cover. `argos rescore <fingerprint>`
(`src/cli/main.ts`) exposes it, the same shape `discard`/
`restore-duplicate` already use.

**Consequence:** this ADR's claim is now an executable invariant, not
documentation ahead of the code — the audit's own recommendation
("express guarantees as executable invariants... until their acceptance
tests pass"). `test/persistence/postings-repository.test.ts` covers the
eligibility boundary directly: a never-scored posting, a successfully-
scored one, and a posting with a stale-but-not-yet-expired scoring claim
(`DEFAULT_STALE_CLAIM_MS`, 4 hours) are all exercised, the last one
because clearing only `notifiedAt` and leaving the old claim in place
would have silently reintroduced a multi-hour window where the fix
appeared to do nothing.

**Reversal cost:** trivial — `rescore` has one call site (the CLI
command); deleting both restores the documented-but-unbuilt state this
amendment fixes.

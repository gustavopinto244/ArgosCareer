# ADR-039 — Stop the batch on a permanent transport failure, and narrow what trips the shared circuit breaker

## Status

Accepted

## Date

2026-08-17

## Context

Item 3 of `docs/audit/POST_REMEDIATION_CHANGE_AUDIT_2026-08-17.md`'s
recommended fix order (§11): PR-007 (HIGH), PR-008 (MEDIUM), PR-009
(MEDIUM) — three findings at the same boundary (`OpenRouterClient`,
`CircuitBreaker`, `executeDeliver`), building on ADR-035's retry taxonomy.

**PR-007.** `parseModelOutputWithRetries` already classifies a permanent
transport failure (401/403 auth, or an unclassified 4xx `configError`) and
returns it on the first attempt, no retry — ADR-035's whole point. But by
the time that reaches `executeDeliver`, `StageAExtractor`/`StageBMatcher`
collapse it into the same `"extraction_failed"`/`"matching_failed"` reason
any other failure gets, and the score loop moves on to the next posting
regardless. A revoked API key or an invalid model name is a fact about
_this run's configuration_, not about the one posting that happened to
surface it first — every other posting in the batch is equally doomed. The
audit's measured consequence: three requests per posting became one
(ADR-035), but a 1,000-posting backlog with a bad key still made 1,000
known-doomed requests, one per posting, and — combined with ADR-038's
bounded-retry ceiling shipping first — up to `maxScoreFailures` times each
across that many nightly runs before any individually gave up.

**PR-008.** Already fixed in this same change set — see the `beforeCall`
half-open-exclusivity fix below, folded into this ADR's Decision since it
belongs to the same file and the same audit item.

**PR-009.** `OpenRouterClient.complete()` called
`this.circuitBreaker.onFailure(true)` unconditionally for `invalidEnvelope`
(malformed JSON body) and `invalidOutput` (empty `choices`) — both facts
about _one response_, not the provider. Five content-filtered answers
across five unrelated postings could trip the shared breaker and block
every other posting's calls for a full cooldown, the "systemic" failure the
breaker exists to reserve itself for. Separately, HTTP 408 (Request
Timeout) fell through `classifyHttpStatus`'s default `>= 400` branch to
`configError` — permanent, no retry — despite being exactly the kind of
transient, retryable condition the client's own `AbortController` timeout
already treats as retryable under the identical `"timeout"` category.

## Considered options

### PR-007: let each posting fail independently, rely on ADR-038's ceiling alone

Rejected as insufficient on its own. ADR-038 bounds _how many times one
posting_ gets retried across runs; it does nothing to stop a _single run_
from making one doomed request per remaining posting in the same batch the
moment a permanent, run-wide cause is already known. The two are
complementary, not substitutes — see this ADR's Decision and ADR-038's own
documented interaction note.

### PR-007: a new terminal run outcome (e.g., `"aborted"`) distinct from `"success"`/`"failed"`

Considered. Rejected as unnecessary machinery: `evaluateDeliveryOutcome`'s
existing `scoreFailureRateThreshold` alert (`src/scheduling/domain/alerts.ts`)
already computes `(filteredCount - scoredCount) / filteredCount` — a run
that aborts after scoring 1 of 300 filtered postings produces a ~99.7%
failure rate, which the existing alert already surfaces without a new
outcome value or new alerting code. Adding a distinct outcome would
duplicate a signal that already exists.

### PR-009: keep one `isTransientFailure` set, use it for both retry and breaker decisions

Rejected — the two questions are different (this ADR's whole point):
"should this be retried" and "does this mean the provider is down" have
different answers for `invalidEnvelope`/`invalidOutput`. Reusing one set
for both is what caused the bug.

## Decision

**PR-007 — permanent failures propagate and stop the batch.**
`ExtractionResult`/`MatchingResult`'s `ok: false` variants
(`stage-a-extractor.ts`/`stage-b-matcher.ts`) gain a `permanent: boolean`
field, set from `parseModelOutputWithRetries`'s own
`reason === "permanent_error"` — `false` for every other cause, including
the local `buildStageAPrompt`/`buildStageBPrompt` template-read failure
(a deployment problem, not evidence the whole run's model access is
broken). `ScorerPort.score`'s `ok: false` result gains the same field,
threaded through by `ApiScorer`. `executeDeliver`'s score loop `break`s
immediately after recording a permanent failure — the posting that
surfaced it is still reported and its failure recorded exactly like any
other (ADR-038 applies to it unchanged), but no further posting in
`filtered` is scored this run. Untouched postings stay unnotified,
unchanged, and are reconsidered in full next run once the configuration
problem is fixed.

**PR-008 — the half-open trial is exclusive.** `CircuitBreaker.beforeCall`
now blocks a caller that arrives while the state is already `half_open`,
not only while it is `open` — the original check (`state !== "open"`)
let every caller racing the first one past cooldown through, since the
first caller's own transition to `half_open` satisfied that same
condition for everyone behind it. The state stays `half_open`, refusing
every other caller, until `onSuccess`/`onFailure` resolves it.

**PR-009 — breaker-tripping is a narrower set than retry-worthy.**
`isBreakerTrippingFailure` (`openrouter-client.ts`) covers only
`timeout`/`networkError`/`rateLimited`/`serverError`/`providerError` —
real evidence about the transport. `invalidEnvelope`/`invalidOutput` now
call `onFailure(isBreakerTrippingFailure(...))`, evaluating to `false`;
`authError`/`configError` were already excluded via `isTransientFailure`
before this change and remain excluded now. `classifyHttpStatus` gains an
explicit `408 → "timeout"` case, ahead of the generic `>= 400` fallback —
reusing the same category the client's own request-timeout already uses,
since both mean "no timely response," and both are equally retryable.

## Consequences

- A revoked API key or invalid model name now costs at most one wasted
  request per run, not one per remaining posting — closing PR-007's
  measured worst case (1,000 known-doomed requests down to 1). Combined
  with ADR-038, the full worst case for a permanent, run-wide
  misconfiguration across `maxScoreFailures` nightly runs before a human
  notices is now `maxScoreFailures` requests total, not
  `maxScoreFailures × backlog size`.
- **A permanent failure is not itself surfaced with a distinct
  `scoreFailureReason`.** It still reports as an ordinary
  `extraction_failed`/`matching_failed` entry in the digest, with
  `permanent` visible only to `executeDeliver`'s own control flow, not to
  the human reading the digest. A human seeing one such entry cannot tell,
  from the digest alone, whether it was a content-specific hiccup or a
  batch-aborting configuration problem — only that scoring stopped early
  (visible via the failure-rate alert, or by comparing `filtered` to
  `scored` in the run summary). Distinguishing this in the digest itself
  is left for a future change if it proves needed in practice.
- The shared circuit breaker now opens only on genuine transport-wide
  evidence — a content-filtered or malformed response from one posting
  can no longer block every other posting's calls for a cooldown period it
  did nothing to earn.
- The half-open trial is now genuinely exclusive: exactly one caller
  proceeds after cooldown, every concurrent caller behind it is blocked
  until that trial resolves, closing the "recovery burst" PR-008 named.
- HTTP 408 is now retried with backoff like any other timeout, rather than
  permanently failing on the first attempt — closes the one remaining gap
  in ADR-035's status-code taxonomy the audit found.
- **Reversal cost: low for all three.** `permanent` is an additive field
  with one write site per stage and one read site (`executeDeliver`'s
  `break`); reverting means deleting that one conditional and the field,
  not restructuring the retry/cache logic ADR-035/ADR-038 established.
  `isBreakerTrippingFailure` and the half-open exclusivity check are each
  isolated to `circuit-breaker.ts`/`openrouter-client.ts` with the same
  reversal profile ADR-035 already documented for the rest of that file.

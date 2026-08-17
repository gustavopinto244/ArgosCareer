# ADR-035 — Separate transport retry from output repair, and add backoff and a circuit breaker to the LLM client

## Status

Accepted

## Date

2026-08-17

## Context

Before this ADR, `parseModelOutputWithRetries` (`src/scoring/infrastructure/llm-output.ts`)
treated every failure identically: a rejected `ask()` call — a timeout, a 429,
a 500, a bad API key — was folded into the same loop as "the model answered
with invalid JSON," retried immediately (no backoff), with the error text fed
back into the prompt as if the _model_ had done something wrong. For a
transport failure that is nonsensical: telling the model "your previous
response was invalid: Request failed: connection reset" wastes a turn asking
it to correct output it never produced.

A repository audit (`docs/audit/AUDIT_REPORT.md`, AC-016, HIGH) found the
consequences concretely:

- A 429 or a run of 5xx responses triggered immediate retries with no backoff
  at all — the fastest way to turn a struggling provider into a fully down
  one, and, with Stage B's concurrency (ADR-022, up to
  `DEFAULT_STAGE_B_CONCURRENCY` requirement calls in flight at once), the
  fastest way to multiply one provider hiccup into dozens of simultaneous
  retries.
- A bad or revoked API key (401/403) was retried exactly as many times as a
  transient timeout — three attempts spent confirming a config problem that
  no retry could ever fix.
- Nothing distinguished _why_ a call failed in any log or metric. "How many
  requests did tonight's run actually make, and why did the failures happen"
  was not answerable from the code.

`OpenRouterClient` (`openrouter-client.ts`) already had an `AttemptOutcome`
taxonomy from an earlier finding (AC-015) — but it existed only for usage
accounting (`getUsage()`), not for retry decisions, and lumped every non-2xx
status into one `httpError` bucket regardless of whether it meant "wait and
try again" or "this will never succeed."

## Considered options

### Keep one retry loop, add a status-code check inline

Rejected. The loop already conflates two different kinds of failure (network
vs. content); adding branching for permanence and backoff on top without
separating the two budgets would make the function's control flow
unreadable, and — worse — a transport retry would still consume the same
attempt budget as an output-repair retry, so a single flaky network blip
could exhaust the budget before the model ever got a fair chance to correct
its own output.

### A retry library (e.g. `p-retry`, `cockatiel`)

Rejected. This project's own precedent (`gupy-collector.ts`,
`ciee-collector.ts`, `solides-collector.ts`) already hand-rolls a small
fixed-delay backoff rather than pulling in a dependency for it, and none of
those libraries know the difference this finding actually needs — that a
transport failure and an output-repair failure are different kinds of thing
with different budgets, one of which should never be retried at all.

### Two independent, purpose-built retry budgets inside `llm-output.ts`, plus a typed error from `OpenRouterClient`

Accepted.

## Decision

**`OpenRouterClient.complete()` throws a typed `LlmTransportError`**, tagged
with a `FailureCategory` — `timeout`, `networkError`, `rateLimited`,
`serverError`, `providerError`, `authError`, `configError`,
`invalidEnvelope`, `invalidOutput`, `httpError` (fallback), or `circuitOpen`
— plus a clamped, parsed `Retry-After` when the provider sent a trustworthy
one (numeric seconds or an HTTP-date, capped at 30s so a nightly batch run
never stalls on a single posting) and the raw HTTP status.

`classifyHttpStatus` maps 401/403 → `authError`, 429 → `rateLimited`,
502/503/504 → `providerError` (OpenRouter's own documented vocabulary for
"the upstream model provider is unavailable"), other 5xx → `serverError`,
other 4xx → `configError`. `isTransientFailure` says which categories are
worth retrying at all: everything except `authError` and `configError` —
AC-016's own two named permanent categories. No amount of backoff turns a
bad API key or a malformed request into a valid one.

**`parseModelOutputWithRetries` runs two independent, bounded budgets:**

- **Transport retry** (`maxTransportAttempts`, default 4): triggers on any
  transient `LlmTransportError` (or, defensively, any rejection that is not
  one — treated as `networkError`, preserving the old behavior for a mock
  `ask()` that just throws a plain `Error`). Backs off with full jitter —
  `random() * min(500ms * 2^(attempt-1), 8s)` — honoring the provider's
  `Retry-After` when it sent one instead of computing its own delay. The
  prompt is left unchanged: a transport failure has nothing to do with the
  model's own output.
- **Output repair** (`maxRepairAttempts`, default 3): ADR-006's original
  policy, unchanged — invalid JSON or a schema mismatch retries immediately
  (no backoff, this is not a network problem), feeding the validation error
  back into the prompt.
- **Permanent failure**: `authError`/`configError` return
  `{ reason: "permanent_error" }` on the very first attempt. Zero retries,
  by design.

The two budgets are never traded against each other — a transport failure
never consumes repair budget and vice versa. Total attempts a single call to
`parseModelOutputWithRetries` can ever make is bounded by their sum: the
"teto cumulativo" (cumulative ceiling) AC-016 asks for, derived from the two
budgets rather than tracked as a separate third number that could drift out
of sync with them.

**A shared `CircuitBreaker`** (`src/scoring/infrastructure/circuit-breaker.ts`)
lives inside `OpenRouterClient` — one instance per client, and `build-scorer.ts`
constructs exactly one `OpenRouterClient` per run, shared by both
`StageAExtractor` and `StageBMatcher`. Standard closed → open → half-open
state machine: 5 consecutive _transient_ failures open it (a permanent
failure never counts — one posting's bad config is not evidence the provider
is down for everyone); while open, `complete()` refuses the call before
`fetch` is ever reached, throwing `circuitOpen` (tracked separately from
`attempts`, since it never reached the network); after a 30s cooldown, one
trial call is allowed through (half-open) — success closes it, failure
reopens it and restarts the cooldown. This is what keeps many concurrent
Stage B workers (ADR-022) from each independently retrying their own call
into a provider that is already down for everyone, which no per-call retry
budget alone can prevent.

**Logging**: `parseModelOutputWithRetries` logs each attempt via NestJS's
plain `Logger` (`docs/08-observability.md`: this project deliberately has no
structured logging system, and building one was not what this finding asked
for) — a `warn` line per failure with its category and latency, a `debug`
line per backoff decision, and a `debug` line only when a call _recovered_
after more than one attempt (a clean first-attempt success logs nothing —
logging every one of ~25 Stage B calls per posting would flood a real run
with the least interesting case). An optional `operationLabel` string
(`"stage-a:<fingerprint>"`, `"stage-b:<fingerprint>:<requirement text>"`)
prefixes every line for a human reading logs to correlate attempts with a
posting — plain string interpolation, not a structured field, consistent
with the documented decision not to build correlation IDs into a logging
system this project does not have.

## Consequences

- 429s and 5xx runs now back off instead of immediately re-storming the
  provider — the acceptance criterion AC-016 states directly.
- An auth or config error fails in one attempt, not three, freeing budget
  that used to be spent confirming something retrying could never fix.
- The real maximum number of requests one call can make is derivable
  directly from `maxTransportAttempts + maxRepairAttempts`, both exposed as
  named constants and overridable per call — not something that had to be
  inferred by reading the loop.
- **New failure-classification surface to keep correct.** `classifyHttpStatus`
  and `isTransientFailure` are now load-bearing: misclassifying a genuinely
  permanent status as transient re-introduces the retry storm this ADR
  closes; misclassifying a transient one as permanent gives up on a call that
  a simple retry would have recovered. Both are covered by dedicated unit
  tests (`test/scoring/infrastructure/openrouter-client.test.ts`,
  parameterized over every status code this ADR names).
- **The circuit breaker is shared, deliberately** — a run where the provider
  is genuinely down now fails fast instead of burning the full retry budget
  on every single one of ~25 Stage B calls per posting across a whole
  backlog. The cost: a real, temporary blip that happens to hit 5 consecutive
  requests (unlikely but possible under Stage B's concurrency) can trip the
  breaker and block requests for postings that might otherwise have
  succeeded, for up to the 30s cooldown. Accepted — the alternative (no
  breaker) is unconditionally worse under sustained failure, which is the
  case this exists for.
- **Reversal cost: low.** `LlmTransportError`, `CircuitBreaker`, and the two
  retry budgets are each isolated to their own file/section with one real
  caller; reverting to a single undifferentiated retry loop means deleting
  the classification and budget-splitting logic in `llm-output.ts` and
  passing plain `Error`s from `OpenRouterClient` again, without touching any
  other stage.

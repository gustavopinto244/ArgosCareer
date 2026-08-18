# ADR-052 — Classify OpenRouter in-band errors and separate scoring signals

## Status

Accepted

## Date

2026-08-18

## Context

Production run `01M09Q92RQQF91PDS6YVD1FB4J` left two of three eligible
postings without a score. Its 23 OpenRouter attempts split into 9 successful
transport responses, 4 local timeouts and 10 responses classified as
`invalidOutput`. Both failed postings stopped in Stage A. The same model and
prompt versions had been used on the preceding run, so the evidence showed
real digest impact but did not establish a model or prompt regression.

The client required `choices[0].message.content` for every HTTP 200 response.
OpenRouter's Chat Completions contract also permits provider failures in an
HTTP 200 body, either as a top-level `error` or a choice-level `error` with
`finish_reason: "error"`. Its canonical
`error.metadata.error_type` identifies the underlying failure. Collapsing those
documented envelopes into `invalidOutput` lost retry semantics, provider
routing evidence and the operational cause persisted for the posting.

The same client also imposed a 30-second timeout and 2,048-token output ceiling
on both stages. Historical cold Stage A calls took roughly 40–67 seconds and
produce a requirement list; Stage B produces one bounded match object. One
global policy did not fit both operations.

Finally, the alert `(filtered - scored) / filtered` correctly measured digest
impact but called a single small run a "possible model or prompt regression"
without a baseline, consecutive degraded runs or provider identity.

## Considered options

### Change the model or prompts immediately

Rejected. No prompt/model version changed across the recurrence, and changing
either before classifying the provider responses would remove the best chance
to identify the actual failure.

### Raise the client's global timeout

Rejected. It would make every small Stage B call wait as long as the larger
Stage A operation and still leave in-band errors misclassified.

### Keep logging truncated raw response bodies

Rejected as a permanent solution. A partial model response can contain posting
or profile-derived content. Operational fields are enough for classification
and are safe to persist; the content is neither.

### Parse documented error envelopes, set limits per operation and split alerts

Chosen. It repairs the transport boundary without changing scoring semantics,
the prompt versions or the selected model.

## Decision

`OpenRouterClient.complete` accepts per-call `stage`, `timeoutMs` and
`maxCompletionTokens`. `buildScorer` applies 120 seconds / 2,048 tokens to
Stage A and 30 seconds / 768 tokens to Stage B. These are initial measurement
bounds, not claimed P95 calibration values.

Every request opts into `X-OpenRouter-Metadata: enabled`. The response parser is
permissive about unknown fields but explicitly recognizes top-level and
choice-level errors, `error.metadata.error_type`, `finish_reason`, nullable or
missing content and the generation/provider/model routing fields. Canonical
error types map into the existing retry taxonomy before the outer HTTP status;
this is essential when the outer status is 200. Unknown valid JSON without a
documented error remains `invalidOutput`.

Only content-free diagnostics cross the transport boundary: stage, failure
kind/category, canonical error type, provider, effective model, finish reason,
generation id, HTTP status and final-attempt latency. `StageAExtractor`,
`StageBMatcher` and
`ApiScorer` preserve them through `ScoreResult`; `executeDeliver` persists them
in the score event's metadata. Raw prompts, posting descriptions, response
content and profile evidence are not logged or persisted. Run rows aggregate
outcomes by stage, provider counts, error-type counts and score-failure counts.

Alerting emits two independent signals:

- any eligible posting left without a score produces a digest-impact alert,
  including the persisted failure breakdown;
- LLM-operation health is evaluated only once at least 10 network attempts are
  fully accounted, using the configured `scoreFailureRateThreshold` as a
  compatibility-preserving health threshold and including outcome/provider/
  error-type breakdowns.

Neither signal uses the word "regression". A regression alert remains deferred
until a version/baseline comparison and consecutive-run rule exist.

## Consequences

- A documented OpenRouter provider failure inside HTTP 200 now enters the
  correct retry/breaker category instead of `invalidOutput`.
- Stage A no longer times out below its already-observed cold latency range;
  Stage B retains the shorter deadline and a smaller output budget.
- A failed posting can be traced as, for example,
  `stage-a / transport_failed / providerError / provider_unavailable` without
  exposing model content.
- Router metadata adds bounded response fields and four nullable JSON columns
  are added to `runs`; migration `0024_safe_cargill.sql` is additive.
- Provider counts describe responses for which metadata was available, not
  necessarily every upstream fallback. Cache replays and early edge failures
  may omit routing metadata by OpenRouter's contract.
- The 120-second Stage A value still needs production cold-cache measurement.
  This change makes that measurement attributable; it does not claim the
  incident closed before a post-deploy run validates latency, success and cost.
- `scoreFailureRateThreshold` retains its old name to avoid invalidating
  existing criteria files, but now gates the LLM-operation health signal. Any
  missing score alerts independently of that threshold.

## Amendment 1 — 2026-08-18: Stage A's completion-token ceiling, not the provider, was the dominant cause

Post-deploy validation (manual `deliver`, run `01M0AJ0CY37MD7XAWX5XZEQNR0`) confirmed
part of this ADR's decision and falsified another candidate cause. Confirmed: the
120s Stage A timeout worked — zero `timeout` outcomes this run, versus 4 the
run before. Falsified: `llmErrorTypeCounts` came back `{}` — none of the
13 `invalidOutput` failures carried a documented OpenRouter error envelope, so
the in-band-HTTP-200-error hypothesis this ADR led with was not what actually
happened here.

What the new diagnostic fields did show, uniformly, across all 13 failures:
`finishReason: "length"` with empty `message.content`, spread across **8
different providers** (GMICloud, CoreWeave, SiliconFlow, StreamLake, Sail
Research, Parasail, AkashML, AtlasCloud). Uniform across that much provider
diversity rules out one flaky provider and points at the shared variable
instead: `STAGE_A_MAX_COMPLETION_TOKENS`, still `DEFAULT_MAX_COMPLETION_TOKENS`
(2,048) from before this ADR — untouched because the original diagnosis
suspected transport, not the token budget. `deepseek/deepseek-v4-flash-0731`
most plausibly spends part of that budget on reasoning output that never
reaches `message.content`, leaving nothing for the JSON requirement list Stage
A actually needs. Stage B, at 768 tokens for one short object, failed far less
(2/17) — consistent with a budget problem that bites harder the more the model
has to produce.

**Decision:** raise `STAGE_A_MAX_COMPLETION_TOKENS` to 8,192 — 4x, generous
headroom for reasoning tokens plus a full requirement list, still far below
`DEFAULT_MAX_RESPONSE_BYTES`. Left `STAGE_B_MAX_COMPLETION_TOKENS` alone: its
failure rate was already low and its output is one bounded object, not a list.

Same discipline as the ADR's original bounds: an initial measurement value,
not a calibrated one. If `finishReason: "length"` recurs at 8,192, the next
move is measuring actual completion-token usage on a successful Stage A call
(currently not persisted per-attempt) before raising it again blindly.

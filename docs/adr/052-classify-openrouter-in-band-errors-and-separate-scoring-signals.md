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

## Amendment 2 — 2026-08-18: cap reasoning tokens directly; raising the ceiling alone did not work

Amendment 1 shipped and was validated with a real `deliver` run
(`01M0AP3D2ZFVNNDCK4M6DDR29D`). Digest impact was unchanged — still 1/3
postings scored — and the failure mode got worse: 6 of 7 Stage A attempts
timed out at ~120s (versus 0 timeouts pre-Amendment-1), and the circuit
breaker tripped once. Raising `maxCompletionTokens` gave the model more
room, and it used all of it without finishing.

Both failing postings — same two fingerprints in every run of this incident
— were isolated and called directly against OpenRouter, once each, no retry
loop, both as originally collected and with all emoji stripped (testing the
one alternate hypothesis this ADR's diagnosis had not ruled out). All four
calls returned `finish_reason: "length"` with `content: null` or
mid-JSON-truncated. All four carried a `reasoning` field 70,000–75,000
characters long — chain-of-thought the model produces before ever writing
the JSON answer, consuming the entire completion-token budget regardless of
emoji or provider (GMICloud in all four, this time). This — not routing
variance, not a documented in-band error, not Unicode content — is the
actual mechanism: `deepseek/deepseek-v4-flash-0731` is a reasoning model,
and Stage A's completion ceiling was always shared between reasoning and
the answer, with no way to bound the former.

OpenRouter documents a `reasoning` request object for exactly this
(`openrouter.ai/docs/use-cases/reasoning-tokens`): `reasoning.max_tokens`
caps the chain-of-thought budget independently of `max_tokens`;
`reasoning.effort: "none"` disables it outright.

**Decision:** add `reasoningMaxTokens` to `OpenRouterClient.complete`'s
per-call options, sent as `reasoning: { max_tokens }` when present. Set
`STAGE_A_REASONING_MAX_TOKENS = 3_000` (of 8,192 — ~37%, leaving the
majority for the JSON answer) and `STAGE_B_REASONING_MAX_TOKENS = 300` (of
768, the same ratio). Not `effort: "none"`: reasoning may still help the
model classify an ambiguous requirement's `weight` correctly, and this
incident produced no evidence either way on that trade-off — capping is the
smaller, more reversible move.

### Consequences

- A reasoning model can no longer silently spend an entire operation's
  completion budget on chain-of-thought never surfaced to `content`.
- Not yet re-validated against production — the next `deliver` (scheduled or
  manual) is what confirms whether 3,000/300 is enough, still leaves the
  same two postings unscored, or needs its own follow-up amendment.
- If reasoning quality measurably matters for weight classification, a
  future amendment might raise these caps or split them per requirement
  category rather than drop them to `none`; no data supports that decision
  yet.

# ADR-013 — Calibrate against DeepSeek V4 Flash, reorder Stage B for prompt caching

## Status

Accepted

## Date

2026-08-15

## Context

The M7 calibration protocol (`docs/04-scoring-model.md`) was first attempted
against `OllamaScorer` with `qwen3:4b` directly, skipping `ApiScorer` — exactly
the option ADR-012 already rejected and recorded, for exactly the reason
recorded there: it does not finish. In practice it was worse than "15 minutes
per iteration": `qwen3:4b` is a thinking model, and on a contended CPU its
hidden `<think>` reasoning consistently exceeded `OllamaClient`'s 180s timeout
on anything but the two shortest of 16 labeled postings. The calibration run
(2026-08-15) finished with `scored = 2/16`, an 88% parse-failure rate, and no
usable correlation — not a calibration result, a confirmation that the
`ApiScorer`-first ordering in `CLAUDE.md` §14 is correct and should not be
skipped again. `OllamaScorer` and its calibration tooling (PR #18) are not at
fault and are not touched by this ADR — they remain the intended production
adapter for Atlas once a model is actually calibrated; this ADR only concerns
which model backs `ApiScorer` during calibration itself.

Separately, while investigating the cost of iterating through `ApiScorer`
several times per the calibration protocol's "one variable at a time" rule,
it became clear Stage B's prompt shape actively worked against the one cost
lever available: prompt caching. Stage B runs once per requirement, many
requirements per posting — the highest call volume in the pipeline — and
`buildStageBPrompt` (`b-v1`) sent the per-call requirement text before the
large, per-run-constant `PROFILE_EVIDENCE` block. Caching (OpenRouter,
DeepSeek and most providers) matches a shared **prefix**; putting the part
that changes on every call first means no request shares a meaningful prefix
with any other, and the block most worth caching never gets the chance.

## Considered options

### Keep iterating on a local model (Ollama) for calibration

Rejected, again. `CLAUDE.md` §14 already made this call and this session's
run demonstrated why: with limited CPU (a personal machine also running other
work, not a dedicated Atlas-like box for iteration), even the "small" 4B
candidate cannot reliably answer inside a workable timeout. Raising the
timeout only trades a bad calibration cadence for a very slow one and keeps
the machine pegged for the duration — the original problem that prompted this
investigation.

### OpenAI or Anthropic directly, instead of OpenRouter

Rejected for the same reason ADR-012 rejected them: binds `ApiScorer` to one
vendor's lineup, and calibration explicitly wants to swap `LLM_MODEL` as a
config value, not an adapter rewrite.

### A larger/more capable model on OpenRouter (e.g. a full-size frontier model)

Deferred, not rejected. Would likely reduce parse-failure rate further and is
worth a row in the calibration table, but costs more per token and the
calibration protocol's own point is to find the cheapest model that clears
the bar — starting there skips the comparison the protocol exists to make.
`deepseek/deepseek-v4-flash-0731` is the starting candidate, not the only one.

### Leave Stage B's prompt ordering as `b-v1` and accept the caching loss

Rejected. The reorder is free — same JSON output contract, same fields, no
behavior change to `StageBMatcher` or the domain types — and the call volume
Stage B generates is exactly the shape that makes a shared cached prefix
valuable. There was no reason to leave it as-is once noticed.

### Restructure `OpenRouterClient` into multi-message calls with explicit `cache_control` breakpoints (Anthropic-style)

Deferred. DeepSeek's context caching (like OpenAI's) is automatic on a
matching prefix within a single message — no `cache_control` markers, no
system/user message split required. This only becomes necessary if a future
`LLM_MODEL` swap moves to a provider that requires explicit cache breakpoints
(Anthropic models via OpenRouter); recorded here so the reasoning is not lost
if that swap happens.

## Decision

- `ApiScorer` calibration proceeds against `LLM_MODEL=deepseek/deepseek-v4-flash-0731`
  (the pinned GA build — not `-latest`, so the model under test cannot shift
  mid-comparison), `SCORER_ADAPTER=api`, via the existing `OpenRouterClient`
  (ADR-012). No adapter code changes.
- Stage B's prompt is reordered into a new version, `b-v2`
  (`prompts/stage-b-matching.v2.md`): every static block — instructions,
  decision criteria, output format, and the full candidate evidence
  list — comes first; the per-call `{{REQUIREMENT_TEXT}}` /
  `{{REQUIREMENT_CATEGORY}}` / `{{REQUIREMENT_WEIGHT}}` block comes last.
  `b-v1` is kept, unedited, per this repo's prompt-versioning convention.
  Stage A's prompt is not reordered — it already runs once per posting, not
  once per requirement, so there is no shared prefix across separate calls
  to gain (the description differs by posting either way).

## Consequences

- Old cached Stage B matches (`b-v1`, keyed by `(fingerprint, profileHash,
promptVersion)` per ADR-007) are not reused — `b-v2` is a distinct cache key
  by design, so every requirement gets matched fresh under the new prompt.
  Expected and cheap at 16 labeled postings; would need noting if this
  happened against a much larger corpus.
- Calibration results from any `qwen3:4b`/Ollama attempt are not comparable
  to results under `deepseek/deepseek-v4-flash-0731` — different model, and
  now a different Stage B prompt version too. Both changed at once here
  breaks the protocol's own "one variable at a time" rule technically, but
  the Ollama attempt produced no usable baseline to hold constant against, so
  there was nothing to preserve.
- `ApiScorer` calibration now costs real, metered tokens (DeepSeek V4 Flash:
  ~$0.078/1M input, ~$0.157/1M output at time of writing, discounted further
  by cache hits on repeated Stage B evidence within a run) — bounded by
  a 16 (soon up to 50) posting corpus, not a production-volume concern, per
  ADR-012's original acceptance of this trade-off.
- If a future `LLM_MODEL` swap moves to a provider requiring explicit
  `cache_control` breakpoints instead of automatic prefix caching, this ADR's
  prefix reordering is necessary but not sufficient — `OpenRouterClient` would
  additionally need the multi-message restructuring deferred above.

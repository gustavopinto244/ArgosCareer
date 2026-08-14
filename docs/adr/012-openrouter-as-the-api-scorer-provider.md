# ADR-012 — Use OpenRouter as the `ApiScorer` provider

## Status

Accepted

## Date

2026-08-14

## Context

`CLAUDE.md` §14 already fixes the scorer adapter order: `StubScorer` →
`ApiScorer` → `OllamaScorer`, `ApiScorer` first because a 15-minute local batch
per iteration makes the M7 calibration protocol (`04-scoring-model.md`) too slow
to finish. `docs/09-configuration.md` reserves `LLM_API_KEY` for this adapter but
never names a provider — the question was left open on purpose until M7, per
`03-technical-decisions.md`'s rule that scorer adapter selection becomes an ADR
next to the code that implements it.

The calibration protocol's step 3 is "change one variable at a time — model,
prompt, weights, cutoffs." That requirement shapes this decision as much as cost
or familiarity does: whatever `ApiScorer` calls needs to make swapping the
_model_ trivial, without swapping the _adapter_, or every model comparison
becomes a code change instead of a config change — which is exactly what
principle 4 (`02-architecture.md`) says a scorer swap must not be.

## Considered options

### OpenAI directly

Rejected as the sole provider. The SDK and API are well documented, but binds
`ApiScorer` to one vendor's model lineup. Comparing a small model's calibration
result against a larger one, or against one of the local candidates
(`qwen3:4b`, `phi4-mini`, `gemma3:4b`) under the same code path, is not possible
without a second adapter or a second API key management path.

### Anthropic directly

Rejected for the same reason as OpenAI — a single-vendor endpoint works for one
model family but reintroduces an adapter change every time M7 wants to compare
against a model that vendor does not host.

### OpenRouter

Accepted. A single OpenAI-compatible `/chat/completions` endpoint in front of
many providers and models — including hosted variants of the same model
families being evaluated locally (`qwen`, `gemma`, `phi`) alongside larger
models. One `LLM_API_KEY`, one HTTP client, one adapter; the model under test
becomes a configuration value (`LLM_MODEL`), which is what the calibration
protocol's "change one variable at a time" actually requires in practice.

The trade-off accepted: a routing layer between the caller and the model,
rather than a first-party SDK. OpenRouter is a for-profit intermediary, not the
model vendor, and its own uptime and pricing markup become a dependency this
project did not have before.

### Skip `ApiScorer`, calibrate directly against `OllamaScorer`

Rejected — this is the option `CLAUDE.md` §14 already rejected outright: a
15-minute local batch per calibration iteration means the calibration protocol
does not finish. Recorded here only so the reasoning is not lost a second time.

## Decision

`ApiScorer` calls OpenRouter's OpenAI-compatible `/chat/completions` endpoint.
Configuration, per `docs/09-configuration.md`:

```
LLM_API_KEY=       # OpenRouter key, required when SCORER_ADAPTER=api
LLM_BASE_URL=      # default https://openrouter.ai/api/v1
LLM_MODEL=         # e.g. openrouter/auto, or a specific model slug
```

`LLM_BASE_URL` defaults to OpenRouter but is not hardcoded to it — the client is
written against the OpenAI-compatible chat-completions shape, which several
providers implement, so pointing it elsewhere later (a direct OpenAI key, a
self-hosted OpenAI-compatible gateway) is a configuration change, not a rewrite.

## Consequences

- Comparing candidate models during calibration is changing `LLM_MODEL`, never
  touching `ApiScorer`'s code — the calibration protocol's "one variable at a
  time" rule is enforceable rather than aspirational.
- The project now depends on OpenRouter's availability and pricing in addition
  to whichever underlying model is selected. If OpenRouter has an outage,
  `ApiScorer` fails the same way any LLM failure does (ADR-006) — bounded
  retries, then a typed failure result — not a special case.
- OpenRouter's per-token markup over a first-party API is a real, ongoing cost.
  Acceptable for calibration's bounded, one-time-per-configuration usage
  (50 postings × N configurations); would need reassessing if `ApiScorer` were
  ever the production adapter instead of `OllamaScorer`.
- Reversing this means writing a provider-specific client and losing the
  "swap the model via config" property for calibration — the OpenAI-compatible
  shape is what makes reversal cheap if it comes to that: a direct-OpenAI client
  is a strict subset of what the OpenRouter client already handles.

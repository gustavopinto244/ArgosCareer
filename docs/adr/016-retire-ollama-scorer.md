# ADR-016 — Retire `OllamaScorer`; `ApiScorer` is the permanent production adapter

## Status

Accepted

## Date

2026-08-15

## Context

`CLAUDE.md` originally planned a scorer-adapter progression ending in
`OllamaScorer` as the production target — a local model running on Atlas,
under `OLLAMA_KEEP_ALIVE=0`, chosen to keep the nightly LLM cost at zero and
avoid depending on a third-party API for the pipeline's core function.
`OllamaScorer`/`OllamaClient` were built during M7, ahead of schedule, once
OpenRouter's free tier proved too rate-limited to finish even one calibration
pass.

Every real attempt to actually run it produced evidence against the plan,
not for it:

- The one full calibration run against `qwen3:4b` via `OllamaScorer`
  finished with an **88% parse-failure rate** (`docs/10-milestones.md`, M7).
  The cause was diagnosed, not mysterious: a thinking model's hidden
  `<think>` reasoning exceeded `OllamaClient`'s request timeout under CPU
  contention on non-dedicated hardware. Real, but never re-attempted to
  confirm a fix, because —
- **Ollama was never installed on Atlas.** Checked directly by SSH during
  M8 planning: no binary, no systemd unit. Installing it meant taking on a
  new, unconfined process on a box already running `atlas-manager`, Nginx,
  cloudflared and this project's own container, for a scorer with no passing
  calibration run behind it.
- `ApiScorer`'s real, measured numbers left nothing for a local model to win
  on. A full 16-posting calibration batch against `deepseek-v4-flash-0731`
  cost **$0.033** (M7) — not a per-request estimate, an actual OpenRouter
  bill. The deployed container's real memory footprint is **29.3 MiB at
  rest**, unchanged during a real `collect` and `deliver` cycle (M8) — because
  `ApiScorer` makes HTTP calls and holds nothing large in-process, it never
  approaches the ~150 MB budget `OllamaScorer` would have shared with
  `atlas-manager` and the rest of Atlas, let alone the ~3.2 GB Ollama itself
  peaks at while a model is loaded.

The case for a local model was resource cost and independence from a
third-party API. Real numbers removed the first reason and never addressed
the second strongly enough to justify the operational cost of running,
confining and calibrating a model on shared hardware that has never
successfully scored a real batch.

## Considered options

### Keep `OllamaScorer` as a documented-but-unused future target

Rejected. `CLAUDE.md` §15 says code comments and documentation explain
_why_, and unused, uncalibrated code sitting in the roadmap as "the
production target" is not a why, it's a stale claim — the exact kind of
thing this project's own discipline (ADR immutability, "done means
demonstrable") exists to prevent accumulating. If local-model scoring
becomes worth revisiting, it is a new decision with its own evidence, not a
default inherited from before any of this was measured.

### Install Ollama on Atlas now, with a memory cap, and finish a calibration pass

Deferred, not rejected outright — this was M8's original plan for the
`OLLAMA_KEEP_ALIVE` checklist item. Reconsidered once `ApiScorer`'s real
cost and memory numbers came in during M8: there is no longer a resource
problem for a local model to solve. Revisit if a reason other than "it was
always the plan" appears — e.g., OpenRouter/DeepSeek pricing or availability
changes materially, or the project's use grows enough that API cost becomes
a real constraint rather than cents per night.

### Keep both adapters, `ApiScorer` as default

Rejected. `ScorerPort`'s whole point (principle 4, `02-architecture.md`) is
that swapping implementations is cheap _when there is a reason to swap_.
Carrying a second, uncalibrated, never-deployed adapter's code, tests and
documentation indefinitely is the cost of that optionality without a
benefit anyone is using — YAGNI, not architecture.

## Decision

`OllamaScorer`/`OllamaClient` are deleted: `src/scoring/infrastructure/ollama-client.ts`,
its tests, the `"ollama"` branch of `buildScorer` (`build-scorer.ts`), and the
`SCORER_ADAPTER=ollama` path in `scripts/run-calibration.ts`. `ScorerPort` now
has exactly two adapters: `StubScorer` (tests, M1) and `ApiScorer`
(production, ADR-012/013).

`CLAUDE.md` §5 and §14, `docs/02-architecture.md`'s ports table and principle
4, `docs/09-configuration.md`, and `.env.example` are updated to describe
current reality — `SCORER_ADAPTER` is `stub | api`, full stop.

**Not touched**: the historical record. `README.md`'s calibration table and
`docs/10-milestones.md`'s M7 narrative keep every real finding from the
`OllamaScorer` attempts — the 88% parse-failure rate, the timeout diagnosis,
the free-tier rate-cap discovery that pulled it forward from M8. ADRs and
milestone history are immutable once accepted (`03-technical-decisions.md`);
this ADR supersedes the _plan_, not the _record_ of what was tried and found.

## Consequences

- **Simpler for real**: one fewer adapter to keep passing typecheck/lint/tests,
  one fewer thing `buildScorer`'s callers need to branch on, no
  `OLLAMA_BASE_URL`/`OLLAMA_KEEP_ALIVE` configuration surface to document or
  get wrong.
- **A real dependency on OpenRouter's availability and pricing**, unchanged
  from ADR-012's original trade-off — this ADR just stops treating that
  trade-off as temporary.
- **Reversing this has a real cost**, not just a `git revert`: `OllamaClient`
  worked (verified against a real local call) and can be rebuilt from this
  ADR's git history, but a future local-model attempt starts over on
  calibration — the 88% failure rate was never resolved, only routed around.
  Anyone reviving this should re-read `docs/10-milestones.md`'s M7 findings
  first, not rediscover them.
- `qwen3:4b`, `phi4-mini`, `gemma3:4b` — the local-candidate shortlist in the
  old `CLAUDE.md` §14 — are no longer a live benchmark row list. If local
  scoring is revisited, that shortlist is a reasonable starting point, not a
  commitment.

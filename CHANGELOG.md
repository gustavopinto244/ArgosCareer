# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Nothing has been released yet.** The first tagged release is cut at **M6**,
the vertical slice, because that is the first point at which the system does the
thing it exists to do — a real posting arriving on the phone. Everything below
is foundation work, listed so the reasoning is traceable before there is any
version to attach it to.

## [Unreleased]

### Added

- `CLAUDE.md`, carrying the full project context so no session depends on the
  original prompt.
- `docs/01-vision-and-scope.md` — goals, non-goals, success criteria, open
  questions, and the honest limit: this is not an ATS simulator.
- `docs/02-architecture.md` — pipeline, the four principles, ports, decoupled
  cadence, dedup, pre-filter, Atlas resource budget, collector etiquette, and an
  explicit list of unverified assumptions.
- `docs/03-technical-decisions.md` — ADR index and rules, including the test for
  amendment versus supersession.
- `docs/04-scoring-model.md` — the three-stage model in full, including the
  `lowConfidence` rule for postings with no extractable requirements.
- `docs/05-domain-model.md` — entity boundaries and invariants, deliberately not
  restating the types.
- `docs/06-glossary.md` — domain vocabulary and the code/digest translation
  boundary that ADR-003 created.
- `docs/07-testing-strategy.md` — resolves the fixture problem ADR-004 created:
  raw API captures stay gitignored, and committed curated fixtures are derived
  from them by hand, with recorded provenance.
- `docs/08-observability.md` — log levels, `runId` correlation, the `runs`
  record, and alerting. Written as the counterweight to principle 1, which
  deliberately creates a silent-degradation failure mode.
- `docs/09-configuration.md` — the three-way split between secrets, profile and
  criteria, and the rule that configuration is validated at startup and fails
  loudly.
- `docs/10-milestones.md` — acceptance criteria per milestone. "Done" was
  previously undefined.
- ADR-001 NestJS · ADR-002 CommonJS and strict TypeScript · ADR-003 English
  repository with a pt-BR digest · ADR-004 privacy boundary for a public
  repository · ADR-005 the LLM does not produce the score · ADR-006 invalid LLM
  output as a normal outcome · ADR-007 stage re-execution and idempotency.
- `.env.example` documenting every environment key.
- `CONTRIBUTING.md` and `SECURITY.md`.
- TypeScript, ESLint, Prettier and Vitest toolchain.
- CI on Node 22 and 24: lint, format check, typecheck, tests.
- `.gitignore` excluding the master profile, postings database, `.env` and raw
  API fixtures — committed before any other file existed, so no wildcard could
  ever have staged them.
- Pull request and ADR templates.

### Changed

- `trackAlignment` defined. It was 15% of the score and existed only as a
  symbol, which blocked M1 from implementing stage C.
- Back-end development and information security are now **equal** first
  priorities, expressed as equal track weights rather than as a special case in
  the formula.
- Module resolution moved from `node16` to `nodenext` after measuring that Node
  supports `require(esm)` unflagged from 22.12.0. `vitest.config` reverted from
  `.mts` to `.ts`; `engines` tightened to `>=22.12.0`. Recorded as an amendment
  to ADR-002 rather than an edit, since the original text claimed the `.mts`
  extension was load-bearing.

### Realigned against the expanded product vision

The project brief was expanded from "job radar" to "data-driven career
assistant". Reconciling it with what was documented produced these changes.

- **The three questions** are now the spine of `docs/01`, `CLAUDE.md` and the
  README: which postings are best, what to improve, how to present the profile.
- **M10 — market intelligence and gap analysis** added, deliberately after M7.
  Aggregating over an uncalibrated score would produce a study plan built on
  noise.
- **Skill taxonomy** identified as a prerequisite for question 2 and scheduled
  for M10. The profile's per-competency aliases are the wrong tool: they
  describe one profile, so counting with them measures only what is already
  known.
- **Resume recommendation is in v1; generating prose is not.** `docs/01` draws
  the line, and `docs/04` adds `recommendedVariant` and `highlights` as pure
  functions over stage B output — no extra model call, nothing invented.
- **Junior and entry-level roles reconsidered and kept out**, with the reasoning
  and two observable conditions for revisiting recorded rather than left
  implicit.
- **`location` and `workMode` split into separate axes**, and `seniority` and
  `experienceYears` promoted to extracted fields rather than title patterns.
- **ADR-008** places n8n as a pluggable collector adapter and an outbound API
  consumer, never as the orchestrator — the Hermes boundary applied to a
  different vendor.
- **Per-posting digest format** specified in `docs/02`, with a table showing
  every line's derivation, so nothing in it can quietly become generated text.

### Changed — cadence

- **ADR-009 — the digest moves from twice-weekly to daily, confined to a
  nightly window.** Collection now runs every few hours, low volume, no LLM.
  Scoring and delivery run once nightly, in a configured off-peak window
  (default `03:00 America/Sao_Paulo`) — the only point the LLM runs and the
  only time the digest is delivered. Worst-case discovery-to-delivery latency
  drops from up to four days to under 24 hours, and the model now loads once
  per day instead of at unspecified times that could contend with Atlas's
  daytime traffic.

### Fixed

- **ADR-007 amended: upserts must preserve first sighting.** The original
  decision made every collection an upsert keyed by `(source, sourceId)`, which
  a naive implementation would use to overwrite `collectedAt` — making every
  posting look like it was found today, silently and irrecoverably. `Posting`
  now carries `firstSeenAt` (written once, never modified) and `lastSeenAt`
  (overwritten each sighting). Lands in M4 with the schema, because it is
  trivial to add now and impossible to backfill later.

### Known gaps

Carried deliberately, and tracked where they will be closed:

- **n8n's memory footprint is unmeasured.** An idle instance is plausibly larger
  than ArgosCareer's entire ~150 MB budget. Measured in M8; if it does not fit,
  ADR-008's inbound half is dropped and the outbound half survives.
- The Gupy response schema is **unverified** — no request has been made from
  this repository (M3).
- The "~70% pre-filter cut" is an estimate, not a measurement (M5).
- The "~150 MB at rest" budget is an estimate, not a measurement (M8).
- English level, minimum stipend and maximum weekly hours are unanswered in the
  profile (M2). The English gap is the damaging one: unresolved, it biases every
  score downward and would corrupt the M7 calibration.

[unreleased]: https://github.com/gustavopinto244/ArgosCareer/commits/main

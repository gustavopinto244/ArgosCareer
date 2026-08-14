# 10 — Milestones and acceptance criteria

The milestone list existed from M0 with no definition of "done", which makes a
milestone a topic rather than a commitment. This page defines completion.

## Rules

- **One pull request per milestone**, against `main`, squash-merged with green
  CI. Over ~15 files, split it.
- **A milestone is done when every criterion below is demonstrable**, not when
  the code exists. "Demonstrable" means a command someone can run or an artifact
  someone can look at.
- **Non-obvious decisions become ADRs in the same commit** as the code
  implementing them (`03-technical-decisions.md`).
- Milestones are sequential. M6 is the exception worth protecting: it is a
  vertical slice, and slices that get postponed become slices that never happen.

## M0 — Bootstrap ✅

Delivered in PRs #1 and #2, hardened in #3 and #4.

- [x] `CLAUDE.md` answers what to build and what never to do, without the
      original prompt
- [x] `docs/01`–`10`, ADR template, ADRs 001–008
- [x] `.gitignore` excludes profile, database, `.env` and raw fixtures — from
      before any other file existed
- [x] CI green on Node 22 and 24: lint, format, typecheck, test

## M1 — Domain and stage C ✅

- [x] `Posting` and `RawPosting` as distinct types, with the invariants in
      `05-domain-model.md` enforced
- [x] Fingerprint as a pure, unit-tested function in the domain layer
- [x] Stage C score computation: pure, deterministic, no I/O
- [x] `CollectorPort`, `ScorerPort`, `NotifierPort` defined, all returning
      failure as a value
- [x] NestJS skeleton (`AppModule`, `main.ts`, built and boots for real) with
      the `domain` / `application` / `infrastructure` / `composition` layering
      established; domain imports no framework. `application`,
      `infrastructure` and `composition` folders are not scaffolded empty —
      they land per bounded context starting M2, when something needs them
- [x] Unit tests covering every scoring branch: blocking cap including
      `partial`, empty-category coverage, `lowConfidence`, verdict boundaries at
      exactly 45 and 70, `trackAlignment` including `unknown` and multi-track
- [x] **`--passWithNoTests` removed from `npm test`**
- [x] TypeScript 7 reassessed against Nest's `emitDecoratorMetadata` (ADR-002
      Amendment 2) — the metadata concern is unfounded, `typescript-eslint`
      refusing to run under TS 7.0 is the real blocker; staying on 6.0.3

## M2 — Master profile ✅

- [x] Zod schema for `config/profile.yaml`, rejecting a competency with no
      `evidence`
- [x] Loader failing loudly at startup with the file and field named
- [x] `config/profile.example.yaml` committed, fictional, structurally complete
      — guarded by a test asserting it stays valid against the schema
- [x] Real `config/profile.yaml` written, including the `atlas-manager` evidence
      absent from both resumes
- [x] Academic period derived at runtime, unit-tested at the two boundaries the
      0-indexed month bug would break: August 2026 → 2, March 2027 → 3.
      Also fixed to UTC getters after the local-timezone form failed under
      this sandbox's America/Sao_Paulo clock — see the commit
- [x] `⚠ VERIFY` fields present and visibly unanswered: English level, minimum
      stipend, maximum weekly hours
- [x] `resumeVariants` in the schema — named subsets of the profile, holding no
      prose (`05-domain-model.md`)

## M3 — Gupy collector

- [ ] `npm run fixture:gupy` hits the real API, writes
      `test/fixtures/gupy-raw.json` (gitignored), prints the first item's keys
- [ ] Tolerant Zod schema fitted to the **observed** response, not a guess
- [ ] Curated fixture committed, derived by hand from the raw capture, with
      recorded provenance (`07-testing-strategy.md`)
- [ ] Adapter never throws — contract tests for non-200, timeout, malformed
      body, empty body, connection reset
- [ ] Polite behavior verified: `robots.txt`, ~1.5 s interval, honest
      `User-Agent`, backoff, explicit timeout
- [ ] `docs/02` updated: the Gupy schema moves out of "unverified assumptions"

## M4 — Persistence

- [ ] Drizzle + SQLite, migrations runnable forward from empty
- [ ] Schema implementing the stage keys in ADR-007, writes as upserts
- [ ] **`firstSeenAt` written once and never overwritten by re-collection**, with
      a test asserting a second upsert leaves it unchanged and moves
      `lastSeenAt` (ADR-007 amendment)
- [ ] Rejected postings retained — the corpus is not a cache
- [ ] `runs` table with per-stage counts
- [ ] Deduplication: fingerprint layer, then same-company similarity layer
- [ ] Each stage invocable independently from the CLI — the actual test of
      principle 2
- [ ] Integration tests against a real temporary SQLite file
- [ ] ADR recording the dedup algorithm and its similarity threshold

## M5 — Pre-filter

- [ ] Every rule from `02-architecture.md`, each configurable in
      `config/criteria.yaml`
- [ ] Deterministic track classification feeding `trackAlignment`
- [ ] `location` and `workMode` filtered as separate axes, both allowing
      `unknown` without silently discarding or accepting
- [ ] Every rejection records a reason (`05-domain-model.md`)
- [ ] **The ~70% cut estimate measured** against real collected volume, and
      `docs/02` updated with the real number
- [ ] Unit tests per rule, plus ordering

## M6 — Vertical slice 🎯

The milestone that proves the project is real.

- [ ] Gupy → SQLite → Telegram end to end with `StubScorer`
- [ ] **A real posting arrives on the phone**
- [ ] Digest in pt-BR per the `06-glossary.md` mapping
- [ ] Period-blocked postings in their own section ("opens for you in 2027.1")
- [ ] Run summary in the digest: collected, deduped, filtered, scored, plus any
      source that failed
- [ ] A posting already notified is never notified again (ADR-007)
- [ ] One end-to-end test with a notifier double

## M7 — Real scoring

- [ ] Stages A and B implemented, prompts versioned in `prompts/`
- [ ] ADR-006 policy implemented and tested: fences, prose, truncation, invented
      enums, `met` with `evidence: null` → `not_met`
- [ ] `ApiScorer` first, `OllamaScorer` second — in that order, because a
      15-minute local batch per iteration means calibration never finishes
- [ ] **50 real postings labelled by hand, before looking at model output**
- [ ] Correlation and verdict precision/recall measured; one variable at a time
- [ ] Parse-failure rate measured per candidate model (ADR-006)
- [ ] **Calibration table published in the README, including configurations that
      lost**
- [ ] `seniority` and `experienceYears` extracted as fields, not inferred from
      the title alone (`05-domain-model.md`)
- [ ] `recommendedVariant`, `highlights` and `missingTerms` emitted — pure
      functions over stage B output, no extra model call
- [ ] Weights and thresholds updated from the results, or explicitly kept with a
      reason

## M8 — Deployment

- [ ] Docker Compose on Atlas
- [ ] Scheduling live: collection every few hours, score+deliver in the nightly
      off-peak window (ADR-009)
- [ ] `OLLAMA_KEEP_ALIVE=0` verified — the model actually unloads after a batch
- [ ] **Memory measured under real load** against the ~150 MB / ~250 MB budget,
      and `docs/02` updated with the real figure
- [ ] Database backup, and a restore actually rehearsed
- [ ] Alerts from `08-observability.md` live, including consecutive-empty-source
- [ ] **n8n's memory footprint measured** if adopted. If it does not fit
      alongside the existing Atlas containers, ADR-008's inbound half is dropped
      and the outbound half survives

## M9 — API and Hermes

- [ ] HTTP endpoints for stage re-execution and run inspection
- [ ] Health endpoint reporting last successful run per kind
- [ ] MCP server
- [ ] Hermes consuming it — **with the nightly digest still working while
      Hermes is stopped**, which is the test of whether the boundary is real
- [ ] n8n consuming the API for side effects — spreadsheet, reminders,
      cross-post — never on the critical path (ADR-008)
- [ ] ADR recording the API boundary

## M10 — Market intelligence and gap analysis

Answers question 2: _what do I need to improve?_ Deliberately **after M7**, so
that "relevant postings" means something calibrated — aggregating over an
uncalibrated score produces a study plan built on noise.

- [ ] **Skill taxonomy**: canonical skill names with aliases, so `Postgres`,
      `PostgreSQL` and `postgre` count as one. Global, not derived from the
      profile — profile aliases would only count what is already known
- [ ] Taxonomy applied retrospectively over stored stage A extractions, without
      re-running extraction (ADR-007 makes this possible)
- [ ] Aggregate queries over the corpus: most requested technologies, recurring
      competencies, typical experience level, regions, companies hiring most,
      work-mode distribution
- [ ] **Gap analysis**: skills frequent in high-compatibility postings and weak
      or absent in the profile, ranked by frequency — "PostgreSQL appears in 58%
      of relevant postings"
- [ ] Time series over `firstSeenAt`, answering how the market moved
- [ ] Study plan ordered by measured demand, delivered to Telegram on request
- [ ] Aggregates computed over the **whole corpus including rejected postings**
      (`05-domain-model.md`)

## After M6 — additional sources

One per pull request, each meeting the M3 criteria:

- [ ] Google Jobs / Indeed via ephemeral `--rm` Python container
- [ ] LinkedIn, public visitor endpoints only — **never authenticated with a
      personal session or cookies** (`CLAUDE.md` §3)
- [ ] `N8nCollector` behind `CollectorPort`, with one long-tail source proving
      it (ADR-008). Workflow exported and committed to `n8n/`; core verified
      unaffected with n8n stopped

## Where question 3 lands

"How should I present my profile?" is not a milestone of its own — it is output
that falls out of work already planned:

- **M2** adds `resumeVariants` to the profile schema
- **M7** emits `recommendedVariant`, `highlights` and `missingTerms`
- **M6/M7** render them in the digest entry

Generating prose is Phase 3 and stays out.

## Out of v1

Phase 2 feedback (what was applied to, what got a response) and Phase 3
generated communication — resume text, cover letters, recruiter messages.
Recorded in `01-vision-and-scope.md` so they stay out.

Junior and entry-level roles are also out, reconsidered and kept out; the
reasoning and the two observable conditions for revisiting are in
`01-vision-and-scope.md`.

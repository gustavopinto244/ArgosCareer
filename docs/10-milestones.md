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
- [x] `docs/01`–`10`, ADR template, ADRs 001–007
- [x] `.gitignore` excludes profile, database, `.env` and raw fixtures — from
      before any other file existed
- [x] CI green on Node 22 and 24: lint, format, typecheck, test

## M1 — Domain and stage C

- [ ] `Posting` and `RawPosting` as distinct types, with the invariants in
      `05-domain-model.md` enforced
- [ ] Fingerprint as a pure, unit-tested function in the domain layer
- [ ] Stage C score computation: pure, deterministic, no I/O
- [ ] `CollectorPort`, `ScorerPort`, `NotifierPort` defined, all returning
      failure as a value
- [ ] NestJS skeleton with the `domain` / `application` / `infrastructure` /
      `composition` layering; domain imports no framework
- [ ] Unit tests covering every scoring branch: blocking cap including
      `partial`, empty-category coverage, `lowConfidence`, verdict boundaries at
      exactly 45 and 70, `trackAlignment` including `unknown` and multi-track
- [ ] **`--passWithNoTests` removed from `npm test`**
- [ ] TypeScript 7 reassessed against Nest's `emitDecoratorMetadata` (ADR-002),
      and the result recorded either way

## M2 — Master profile

- [ ] Zod schema for `config/profile.yaml`, rejecting a competency with no
      `evidence`
- [ ] Loader failing loudly at startup with the file and field named
- [ ] `config/profile.example.yaml` committed, fictional, structurally complete
- [ ] Real `config/profile.yaml` written, including the `atlas-manager` evidence
      absent from both resumes
- [ ] Academic period derived at runtime, unit-tested at the two boundaries the
      0-indexed month bug would break: August 2026 → 2, March 2027 → 3
- [ ] `⚠ VERIFY` fields present and visibly unanswered: English level, minimum
      stipend, maximum weekly hours

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
- [ ] Weights and thresholds updated from the results, or explicitly kept with a
      reason

## M8 — Deployment

- [ ] Docker Compose on Atlas
- [ ] Scheduling live: collection daily, digest Tuesday and Friday
- [ ] `OLLAMA_KEEP_ALIVE=0` verified — the model actually unloads after a batch
- [ ] **Memory measured under real load** against the ~150 MB / ~250 MB budget,
      and `docs/02` updated with the real figure
- [ ] Database backup, and a restore actually rehearsed
- [ ] Alerts from `08-observability.md` live, including consecutive-empty-source

## M9 — API and Hermes

- [ ] HTTP endpoints for stage re-execution and run inspection
- [ ] Health endpoint reporting last successful run per kind
- [ ] MCP server
- [ ] Hermes consuming it — **with the Tuesday/Friday digest still working while
      Hermes is stopped**, which is the test of whether the boundary is real
- [ ] ADR recording the API boundary

## After M6 — additional sources

One per pull request, each meeting the M3 criteria:

- [ ] Google Jobs / Indeed via ephemeral `--rm` Python container
- [ ] LinkedIn, public visitor endpoints only — **never authenticated with a
      personal session or cookies** (`CLAUDE.md` §3)

## Out of v1

Phase 2 feedback (what was applied to, what got a response) and Phase 3 resume
tailoring. Recorded in `01-vision-and-scope.md` so they stay out.

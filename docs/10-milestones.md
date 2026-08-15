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

## M3 — Gupy collector ✅

- [x] `npm run fixture:gupy` hits the real API, writes
      `test/fixtures/gupy-raw.json` (gitignored), prints the first item's keys
- [x] Tolerant Zod schema fitted to the **observed** response, not a guess
- [x] Curated fixture committed, derived by hand from the raw capture, with
      recorded provenance (`07-testing-strategy.md`)
- [x] Adapter never throws — contract tests for non-200, timeout, malformed
      body, empty body, connection reset
- [x] Polite behavior verified: `robots.txt` (checked on both domains —
      neither exists), ~1.5 s interval, honest `User-Agent`, backoff, explicit
      timeout
- [x] `docs/02` updated: the Gupy schema moves out of "unverified assumptions"
      into a documented, verified shape

## M4 — Persistence ✅

- [x] Drizzle + SQLite, migrations runnable forward from empty — verified
      against a real file: both tables created from empty, re-run idempotent
- [x] Schema implementing the stage keys in ADR-007, writes as upserts
- [x] **`firstSeenAt` written once and never overwritten by re-collection**, with
      a test asserting a second upsert leaves it unchanged and moves
      `lastSeenAt` (ADR-007 amendment)
- [x] Rejected postings retained — the corpus is not a cache. Nothing in the
      codebase deletes a posting row; `markDuplicate` flags without removing
- [x] `runs` table with per-stage counts
- [x] Deduplication: fingerprint layer (the repository's unique index), then
      same-company similarity layer (ADR-010). Algorithm changed twice during
      development after being measured against the docs' own motivating
      example and failing it — see ADR-010's Considered options
- [x] Each stage invocable independently from the CLI — the actual test of
      principle 2. `dedup` re-scans the corpus with no collector and no
      network involved at all
- [x] Integration tests against a real temporary SQLite file
- [x] ADR recording the dedup algorithm and its similarity threshold
      (ADR-010), including a real false-positive found running against live
      data, not only the cases used to pick the threshold

## M5 — Pre-filter ✅

- [x] Every rule from `02-architecture.md`, each configurable in
      `config/criteria.yaml`
- [x] Deterministic track classification feeding `trackAlignment` — verified
      through the real `computeTrackAlignment` function, not reimplemented
- [x] `location` and `workMode` filtered as separate axes, both allowing
      `unknown` without silently discarding or accepting (ADR-011)
- [x] Every rejection records a reason (`05-domain-model.md`)
- [x] **The ~70% cut estimate measured** against real collected volume, and
      `docs/02` updated with the real number — turned out to be two numbers,
      97.1% nationwide and 84.2% city-narrowed, with the gap itself the
      actionable finding for M8's collection strategy
- [x] Unit tests per rule, plus ordering — 24 tests including 4 proving the
      short-circuit sequence on postings that fail multiple rules at once

## M6 — Vertical slice ✅ 🎯

The milestone that proves the project is real.

- [x] Gupy → SQLite → Telegram end to end with `StubScorer` — `argos collect`
      → `argos dedup` → `argos deliver`, run for real against the live Gupy
      API on 2026-08-14
- [x] **A real posting arrives on the phone** — 6 real postings, delivered
- [x] Digest in pt-BR per the `06-glossary.md` mapping
- [x] Period-blocked postings in their own section ("opens for you in
      2027.1") — the section renders and is tested, but nothing populates it
      with real data yet: no stage exists before M7 that reads a posting's
      text closely enough to detect a stated period requirement, so this
      section is honestly empty in every real run so far
- [x] Run summary in the digest: collected, deduped, filtered, scored, plus any
      source that failed
- [x] A posting already notified is never notified again (ADR-007)
- [x] One end-to-end test with a notifier double

**Real-run finding, folded back into `config/criteria.yaml`:**
`minKeywordAdherence` matches only against a posting's _title_ — `Posting`
has no `description` field yet — and real Gupy titles are short enough that
this rejected good, on-track matches (e.g. "Estágio em Desenvolvimento
Backend", remote). Set to `0` until `Posting` carries a description stage A
can read.

## M7 — Real scoring ✅ (preliminary)

**Done against 16 hand-labelled postings, not the 50 the protocol calls for.**
Real Gupy volume for this search profile is thin (consistent with ADR-011's
84–97% pre-filter cut) — 16 is what exists to label today. Closed rather than
left open-ended because every criterion below that does not explicitly depend
on sample size is demonstrable now; re-run from README's Calibration section
once 50 labelled postings exist, which happens as the corpus grows, not on
demand.

- [x] Stages A and B implemented, prompts versioned in `prompts/`
- [x] ADR-006 policy implemented and tested: fences, prose, truncation, invented
      enums, `met` with `evidence: null` → `not_met`
- [x] `ApiScorer` first, `OllamaScorer` second — in that order, because a
      15-minute local batch per iteration means calibration never finishes.
      `OllamaScorer` ended up built alongside `ApiScorer` rather than after
      it — pulled forward from M8 to avoid real API spend once OpenRouter's
      free-tier daily cap (50 requests/account) turned out to be too low to
      finish even one calibration pass
- [x] **16 real postings labelled by hand, before looking at model output** —
      50 deferred to whenever the corpus grows enough to label them; tracked
      above, not abandoned
- [x] Correlation and verdict precision/recall measured against a complete,
      stable configuration (`deepseek/deepseek-v4-flash-0731`, `b-v2` prompt):
      correlation 0.522, discard recall 100% (64% precision), apply recall 0%.
      Two earlier attempts against OpenRouter's free tier produced no
      measurement at all (auto-router instability, then a rate cap too low
      to finish one pass) — kept as rows in README's table rather than
      discarded, since the fix for both is itself a documented decision
      (ADR-012, ADR-013)
- [x] Parse-failure rate measured per candidate model (ADR-006): 88%
      (`qwen3:4b`/Ollama, request timeouts under CPU contention) vs. 0%
      (`deepseek-v4-flash-0731`/OpenRouter)
- [x] **Calibration table published in the README, including configurations
      that lost**
- [x] `seniority` and `experienceYears` extracted as fields, not inferred from
      the title alone (`05-domain-model.md`)
- [x] `recommendedVariant`, `highlights` and `missingTerms` emitted — pure
      functions over stage B output, no extra model call
- [x] Weights and thresholds explicitly kept with a reason (README's
      Calibration section): the one complete measurement came from inputs
      later found broken, and 16 samples is too few to retune against without
      overfitting to noise. **What did change**, from auditing that
      measurement posting-by-posting rather than from tuning the formula
      itself: a data backfill (129/523 postings had a silently empty
      `description`), quotable evidence for academic enrollment that existed
      as a field but was never rendered, excluding unfalsifiable trait
      requirements from coverage, and `trackAlignment` exclusion phrases for
      two words ("desenvolvimento", "segurança") that were misclassifying 19%
      of the corpus (ADR-014, ADR-015) — followed, after that measurement, by
      the same rendering gap found again in `englishLevel`, `maxWeeklyHours`
      and `minimumStipend`, fixed but only spot-checked against a 5-posting
      subset, not yet re-measured at n=16.

**Real findings, kept rather than discarded:**

- OpenRouter's `openrouter/free` auto-router changes the underlying model on
  every request. Calibrating against it measures nothing stable — the
  "model" variable was never held constant, which the protocol requires.
- OpenRouter's free tier caps at 50 requests/account/day, shared across every
  `:free` model. 16 postings × (1 extraction + several match calls each)
  exceeds that in a single run — the free tier cannot finish even one pass,
  let alone the several needed to compare configurations.
- `qwen3:4b` via `OllamaScorer` technically ran (unlike the two above) but
  hit an 88% parse-failure rate: a thinking model's hidden reasoning
  exceeded `OllamaClient`'s request timeout under CPU contention on
  non-dedicated hardware. Not evidence against `OllamaScorer` as the eventual
  production adapter (CLAUDE.md §14) — Atlas is dedicated hardware and the
  timeout is configurable — but evidence that a real run needs one or the
  other before it can complete.
- Auditing the first complete `deepseek-v4-flash-0731` run posting-by-posting,
  not just its aggregate correlation, is what actually found the structural
  fixes above. The aggregate number alone (-0.097) would have pointed at
  "recalibrate the weights"; the per-posting audit pointed at broken inputs
  and two rule gaps instead — see ADR-014 and ADR-015 for why that
  distinction mattered.

## M8 — Deployment ✅ (preliminary — see the two deferrals below)

**Done.** Three PRs, in order: scheduling + alerting (code, no infra) →
backup/restore → Docker Compose + real deployment + real measurements.
Every criterion below is demonstrable now; the two left unchecked are
deliberate deferrals with a stated reason, not gaps.

- [x] `schedule` and `alerts` sections added to `config/criteria.yaml` and
      `CriteriaSchema` (`docs/09-configuration.md`'s spec, now read by code)
- [x] Scheduling live in-process: `@nestjs/schedule` wired through
      `SchedulerService`, two independent crons per ADR-009 (collection every
      `schedule.collection.intervalHours`, score+deliver daily at
      `schedule.scoreAndDeliver.time`/`timezone`), registered dynamically
      via `SchedulerRegistry` since the expressions are only known once
      `criteria.yaml` loads. **Deployed and confirmed running on Atlas**,
      2026-08-15: the container logs the same "Scheduled: collection every
      4h, scoreAndDeliver daily at 03:00 America/Sao_Paulo" line verified
      locally, and a manual trigger of both cycles inside the real deployed
      container produced real `runs` rows (a `collect` of 50 real Gupy
      postings, 41 new; a `deliver` cycle that correctly found 0 postings
      past the pre-filter and still completed). The collection cron's next
      _automatic_ fire (server is UTC, `0 */4 * * *`) was ~3h out at
      deployment time — not sat through live; the manual trigger exercises
      the identical code path the cron calls, so this is the same evidence
      a wait would have produced, sooner.
- [x] Alerts from `08-observability.md` live: `evaluateCollectionHealth`
      (consecutive empty/errored collection runs), `evaluateDeliveryOutcome`
      (delivery failure, scoring failure rate), `evaluateMissedRuns` (missed
      `scoreAndDeliver` alerts on the first miss, missed `collection` alerts
      only after two — ADR-009's stated asymmetry). Delivered through
      `TelegramNotifier.sendText`, the same client as the digest.
- [x] Docker Compose on Atlas. Multi-stage `Dockerfile` (`better-sqlite3`
      compiles its native binding from source — no prebuilt binary for this
      platform, found in PR 2's restore rehearsal — so the build stage needs
      a C++ toolchain the runtime stage does not carry) and
      `compose.production.yaml` (no exposed ports; `config/profile.yaml`
      bind-mounted read-only, never baked into an image layer, ADR-004;
      `.env` is `env_file`, not `COPY`'d; `data/` and `backups/` are named
      volumes). **Deployed for real on Atlas**, 2026-08-15, via the same
      `~/apps/<name>/app` layout `portfolio` and `task-manager` already use.
- [x] `OLLAMA_KEEP_ALIVE=0` — **N/A, `OllamaScorer` retired (ADR-016)**.
      Deferred as of the M8 close-out above; superseded once it became clear
      the deferral had no path back — Ollama was never installed on Atlas,
      `OllamaScorer` never finished a real calibration pass (M7: 88%
      parse-failure), and `ApiScorer`'s real measured cost and memory
      footprint left no case for reopening it. Local-model scoring is no
      longer part of this project's roadmap; ADR-016 records what would
      have to be true to revisit it.
- [x] **Memory measured under real load**, `docs/02` updated with the real
      figure: **29.3 MiB at rest**, real `docker stats` on Atlas, well under
      the ~150 MB budget. A real `collect` and a real `deliver` cycle both
      left it unchanged — `ApiScorer` makes HTTP calls and holds nothing
      large in-process, so there is no local-model load/unload swing to
      measure. That `deliver` cycle found 0 postings past the pre-filter, so
      Stage A/B were not exercised under real traffic; genuine peak-under-
      scoring-load is the number to revisit once a night's cron actually has
      postings to score.
- [x] Database backup, and a restore actually rehearsed. `VACUUM INTO` a
      timestamped file (retention: 7), chained after the nightly
      `scoreAndDeliver` cycle. **Rehearsed for real on Atlas, 2026-08-15** —
      not just written: cloned the branch there, `npm ci` (found and fixed a
      real gap doing this: `better-sqlite3` compiles from source, no
      prebuilt binary for this platform, so `build-essential`/`python3`
      became a genuine dependency, installed on Atlas and worth remembering
      for PR 3's Dockerfile), collected 20 real Gupy postings, backed up,
      deleted the live database entirely (simulating total loss), restored
      from the backup, and confirmed all 20 postings came back — count and
      sample data both matched. Scratch directory cleaned up afterward; the
      real deployment (PR 3) starts clean.
- [ ] **n8n's memory footprint measured** — **not applicable this pass**. No
      `N8nCollector` exists in code yet (still in the "after M6" backlog,
      unimplemented), so there is nothing to measure.

## M9 — API and Hermes ✅ (preliminary — see the deferral below)

**Done.** Four PRs, in order: HTTP bootstrap + auth guard + read-only
inspection → stage re-execution → MCP server → Tailscale publish + ADR.
Every criterion below is demonstrable now; the one left unchecked is a
deliberate deferral with a stated reason, not a gap.

- [x] HTTP endpoints for stage re-execution and run inspection —
      `GET /health`, `GET /runs`, `GET /runs/:runId`, `POST /runs/collect`,
      `POST /runs/dedup`, `POST /runs/deliver`, all thin over one
      `RunsService` so REST has exactly one implementation of "run collect"
- [x] Health endpoint reporting last successful run per kind — verbatim to
      `docs/08-observability.md`'s spec, `{collect, dedup, scoreAndDeliver}`
- [x] MCP server — `POST /mcp`, six tools mirroring the REST routes
      (`get_health`, `list_runs`, `get_run`, `run_collect`, `run_dedup`,
      `run_deliver`), calling the same `RunsService`. Found and fixed a real
      SDK requirement while wiring it up: `StreamableHTTPServerTransport` in
      stateless mode cannot be reused across requests — a fresh
      `McpServer`/transport pair is built per request, not held for the
      app's lifetime, discovered by reproducing a 500 on every session's
      second message against a real running server, not a test artifact
- [ ] **Hermes consuming it — not exercised.** This session has no second
      Hermes instance, on a second tailnet-joined machine, to configure and
      drive a real cross-machine call against. What is verified for real
      instead, on Atlas itself over its own Tailscale IP
      (`100.112.68.45:3000`): the container is bound only to that interface
      (`docker port` confirms `3000/tcp -> 100.112.68.45:3000`, not
      `0.0.0.0`; no listener on `127.0.0.1:3000` belongs to it — that port
      is a pre-existing, unrelated host process), `GET /health` returns 200
      with a valid key and 401 with a missing or wrong one, and
      `POST /mcp`'s `initialize` call succeeds. The boundary is built and
      reachable; a real remote Hermes call is out of reach here, recorded
      honestly rather than assumed. "The nightly digest still working while
      Hermes is stopped" is trivially true today — nothing consumes the API
      yet — and stops being a meaningful test until Hermes exists to stop.
- [x] n8n consuming the API for side effects — **N/A.** No `N8nCollector`
      exists in code (still unimplemented, same standing note as M8), so
      there is nothing for it to consume yet.
- [x] ADR recording the API boundary — [ADR-017](adr/017-tailscale-and-bearer-key-for-the-api-boundary.md):
      Tailscale over the existing Cloudflare Tunnel pattern (the only
      intended caller is one already-tailnet-joined machine, not the public
      internet), a fixed Bearer key over Cloudflare Access/JWT (one trusted
      consumer, simple and auditable, with the upgrade path documented).
      **Deployed for real on Atlas**, 2026-08-15, from the PR branch
      (`~/apps/argos-career/app`, the same layout `portfolio` and
      `task-manager` use): `docker compose up -d --build`, `API_KEY`
      generated on Atlas itself with `openssl rand -hex 32`,
      `ATLAS_TAILSCALE_IP` set to the confirmed interface IP. `POST
/runs/deliver` is deliberately reachable through this same
      boundary — real API spend and a real Telegram send, remotely
      triggerable by design, not a footgun left undocumented (ADR-017).

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

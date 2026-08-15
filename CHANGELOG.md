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

### Added — M7, real scoring 🚧 (in progress)

- Stages A and B (`src/scoring/infrastructure/`): `StageAExtractor` and
  `StageBMatcher`, each caching whole results by ADR-007's keys
  (`(fingerprint, promptVersion)` and `(fingerprint, profileHash,
promptVersion)`), so re-scoring across configurations doesn't re-call the
  model for postings already extracted/matched.
- `parseModelOutputWithRetries` (`src/scoring/infrastructure/llm-output.ts`):
  ADR-006's full policy — normalize, validate, bounded retries with the
  validation error fed back into the prompt, typed failure on exhaustion.
  Treats a rejected model call the same as malformed output, within the same
  attempt budget.
- Versioned prompts in `prompts/` — `stage-a-extraction.v2.md` (adds
  `seniority`/`experienceYears` to v1's requirement list, a new file rather
  than an edit since it's a structural output-shape change) and
  `stage-b-matching.v1.md`.
- `ApiScorer` (OpenRouter, ADR-012) and `OllamaScorer` (local, `qwen3:4b`
  verified) — both implemented, the local one pulled forward from M8 after
  OpenRouter's free tier proved unable to finish even one calibration pass
  (see below).
- `recommendedVariant`/`highlights`/`missingTerms` — question 3 of
  `01-vision-and-scope.md`, three pure functions over stage B's matches, no
  extra model call.
- `Posting.seniority`/`experienceYears` now populated by extraction, not
  only inferred from the pre-filter's title pattern.
- `npm run calibration:generate` / `npm run calibration:run` and
  `computeCalibrationReport` (correlation, verdict precision/recall,
  parse-failure rate) — the calibration protocol's measurement tooling.

**Calibration itself is not done.** Real Gupy volume for this search
profile yields only 16 pre-filter-passing postings today, not 50 — labelled
regardless, as a preliminary set. Two calibration attempts against
OpenRouter's free tier both failed for infrastructure reasons rather than
model quality: `openrouter/free` auto-routes to a different underlying
model per request (nothing stays constant to calibrate against), and the
free tier's 50-requests/account/day cap can't cover even one 16-posting
pass. `OllamaScorer` was built as the resolution — no cost, no cap — but a
full calibration run against it, the correlation/precision-recall
measurement, and the README table are still outstanding.

### Added — M6, vertical slice 🎯

- The real `Digest` shape (`src/delivery/domain/digest.ts`), replacing the M1
  placeholder: recommended/review/period-blocked sections and a run summary
  (collected, deduped, filtered, scored, failed sources), plus a pure pt-BR
  renderer translating only at the `NotifierPort` boundary
  (`06-glossary.md`).
- `TelegramNotifier` (`src/delivery/infrastructure/`): a direct, dumb
  Telegram client. Fails as a value, never throws; splits a digest across
  multiple `sendMessage` calls when it exceeds Telegram's 4096-character
  limit.
- `argos deliver` (`src/cli/main.ts`): pre-filter → `StubScorer` →
  compose → notify over every active, not-yet-notified posting. Only
  postings that appear in a successfully sent digest are marked notified
  (ADR-007) — a failed send or a rejected posting stays a candidate for the
  next run.
- `Posting.sourceUrl` (migration 0003) — the architecture doc marks the
  original posting link as mandatory on every digest entry.
- `deriveProfileKeywords`, `hashProfile` (`src/profile/domain/`) — needed to
  call the pre-filter and `ScorerPort.score` from `deliver`.
- **Run for real** against the live Gupy API on 2026-08-14: collected,
  deduplicated, pre-filtered and delivered 6 real dev-track postings to
  Telegram, including a strong match ("Estágio em Desenvolvimento Backend",
  remote, 100%). **A real posting arrived on the phone.**
- **Real-run finding:** `minKeywordAdherence` matches only a posting's
  title — `Posting` has no `description` field yet — and real Gupy titles
  are too short to repeat a specific competency name verbatim. This
  rejected good, on-track matches, so `config/criteria.yaml` sets it to `0`
  until `Posting` carries a description stage A can read.

### Added — M5, pre-filter

- `applyPreFilter` (`src/prefilter/domain/pre-filter.ts`): six deterministic
  rules — title blocklist, title required, blocked companies, expired,
  location, minimum keyword adherence — short-circuiting at the first
  failure so every rejection records exactly one reason. Order runs cheapest
  and most decisive first.
- Location and `workMode` rejected only when **both** axes are known-bad;
  either being `unknown` passes rather than silently discarding or accepting
  (ADR-011) — an unknown `workMode` cannot be ruled out as remote, an unknown
  `location` cannot be ruled out as the target region.
- `classifyTrack` — deterministic, keyword-based track classification from
  `config/criteria.yaml`, feeding `computeTrackAlignment` from M1 directly;
  verified through the real scoring function, not reimplemented.
- `CriteriaSchema` and `loadCriteria` for `config/criteria.yaml`, committed
  (not gitignored — criteria are neither secret nor personal). `tracks`
  requires an entry for every track via Zod's record-over-an-enum
  completeness check, so a track silently missing its keyword list fails
  loudly instead of quietly classifying everything into `unknown`.
- `Posting.applicationDeadline`, added mid-milestone once the expiry rule
  needed somewhere to read a deadline from. New forward migration; verified
  against a database already migrated to the prior schema, not only from
  empty.
- ADR-011: the six rules, their order, and the unknown-axis leniency rule as
  actual decisions rather than principles left to interpret per call site.
- `readYamlFile` extracted out of `profile-loader.ts` once `criteria-loader.ts`
  needed the identical read-and-parse logic — genuine duplication removed on
  its second occurrence, not speculatively factored out on its first.

### Changed — the ~70% pre-filter estimate replaced with two measured numbers

- `npm run measure:prefilter` measured the real cut against two real
  collections, both against the live Gupy API: **97.1%** nationwide, **84.2%**
  city-narrowed to Rio de Janeiro. The gap is the actionable finding, not
  either number alone — most of what the pre-filter cuts is geography, and
  geography is free to filter server-side via Gupy's `city` parameter before
  a single unwanted posting is downloaded. Recorded as a concrete consequence
  for M8's collection strategy. Updated across `CLAUDE.md`, `README.md`,
  `docs/02`, `docs/05` and `docs/08`.

### Added — M4, persistence

- Drizzle + SQLite schema: `postings` (one row per fingerprint, never
  deleted, `rawPayload` retained so Normalize can be re-run without a network
  request) and `runs` (one row per pipeline execution). Verified against a
  real file, not only typechecked: migrations create both tables from an
  empty database and re-running them is idempotent.
- `normalizeGupyJob` — `RawPosting` → `Posting`, mapping `workplaceType` onto
  the domain's `WorkMode` and city presence onto `Location`'s known/unknown
  split. Returns `null` rather than throwing on an unnormalizable payload.
- `PostingsRepository.upsert` — the core M4 requirement. A second upsert of
  the same fingerprint leaves `firstSeenAt` unchanged and moves `lastSeenAt`,
  verified against a real temporary SQLite file. Implemented as an explicit
  select-then-branch inside a transaction so which columns refresh on a
  re-sighting stays readable instead of implicit in a SQL `SET` clause.
- Similarity dedup layer 2 (ADR-010): same-company, 14-day-window,
  character-bigram Dice similarity on stopword-stripped titles, threshold
  0.35. The algorithm was measured against the project's own motivating
  example and changed twice before being accepted — word-set Jaccard scored
  it 0.14, unweighted character bigrams scored an unrelated pair higher than
  the real duplicate. `dedupSimilarPostings` is independently re-runnable
  over the existing corpus with no collector and no network involved.
- `RunsRepository` — `start`/`finish` around a run's lifecycle, `runId` as a
  ULID per `docs/08-observability.md`.
- CLI (`argos collect`, `argos dedup`), the actual test of principle 2 for
  this milestone. Verified three ways: unit tests against a stub collector
  and a real temporary SQLite file, the dev CLI against the live Gupy API end
  to end, and the compiled `dist/cli/main.js` the `bin` entry points at.

### Fixed — a real false positive found running against live data

- Two postings from the same law firm — "Tributário Contencioso" and
  "Contencioso Cível Estratégico" — scored 0.49 and were merged by the
  similarity dedup layer, but read as prose look like two different open
  roles. Folded into ADR-010 as a concrete, measured limitation rather than
  filed away separately: character-bigram similarity structurally favors long
  shared substrings ("contencioso") over the shorter words that actually
  distinguish two titles.

### Added — M3, Gupy collector

- `npm run fixture:gupy` (`scripts/fixture-gupy.ts`), run for real against
  `https://employability-portal.gupy.io/api/v1/jobs` — public JSON, no auth,
  confirmed rather than assumed. `robots.txt` checked on both
  `employability-portal.gupy.io` and `gupy.io`: neither exists.
- `GupyJobSchema` and `GupyResponseEnvelopeSchema`
  (`src/posting/infrastructure/gupy-schema.ts`), fitted to the observed
  response: `id`/`name` required, everything else optional or nullable,
  `.passthrough()` throughout. `type` and `workplaceType` stay open strings —
  four distinct `type` values turned up in a small sample.
- `test/fixtures/gupy-jobs.json` — curated, committed, fictional, hand-derived
  from the raw capture with provenance recorded in the sibling
  `gupy-jobs.md`, preserving the real oddities observed: `badges` present on
  some items and absent (not null) on others, all three `workplaceType`
  values, `isRemoteWork` not always agreeing with the title.
- `GupyCollector` (`src/posting/infrastructure/gupy-collector.ts`)
  implementing `CollectorPort`: honest User-Agent, explicit per-request
  timeout, exponential backoff on 5xx/network failures (not on 4xx),
  ~1.5 s between paginated requests, fetch injected so no test ever makes a
  real network call. Verified against the live API in addition to the
  mocked contract tests: `collect({ jobName: "estágio", maxResults: 5 })`
  returned 5 real postings, no error.
- `docs/02-architecture.md`'s Gupy entry moved from "unverified assumptions"
  to a documented, verified response shape.

### Fixed — two collector bugs the contract tests caught

- A backoff-exhausted 5xx landed in the outer error handler as a generic
  "Gupy request failed", losing the actual status code. The underlying
  error's message is now folded into the final one.
- `maxResults` was originally bounded against the count of _valid_ postings
  collected rather than raw items scanned. Against a page containing an
  invalid item, this made the collector page further to backfill the
  shortfall — the wrong direction when a source starts degrading, since it
  amplifies request volume against a source that is already failing
  validation. Rebounded against items scanned instead.

### Added — M2, master profile

- `ProfileSchema` (`src/profile/domain/profile.ts`) for `config/profile.yaml`:
  competencies with mandatory evidence (min 1, enforced in the schema), a
  `resumeVariants` array of named subsets of the profile holding no prose —
  an id, emphasized tracks, and competency references by name rather than
  duplicated text. Cross-field integrity enforced with `superRefine`:
  duplicate competency names, duplicate variant ids, and a variant
  referencing a competency that does not exist are all rejected with the
  exact field path attached.
- `loadProfile` (`src/profile/infrastructure/profile-loader.ts`) reads,
  parses and validates the file synchronously at startup, and names the file
  path on every failure — an unreadable file, malformed YAML, or a schema
  violation naming the exact field via `ProfileValidationError`.
- `computeAcademicPeriod` (`src/profile/domain/academic-period.ts`), counting
  semester boundaries per `docs/02-architecture.md`, with both mandated
  checkpoints pinned in tests (August 2026 → 2, March 2027 → 3).
- `config/profile.example.yaml` — fictional, structurally complete, committed
  per ADR-004, guarded by a test asserting it stays valid against the schema
  as it evolves.
- The real `config/profile.yaml` — gitignored, verified `git add` refuses it
  both before and after writing real content. 22 competencies, including the
  `atlas-manager` evidence CLAUDE.md §9 lists as absent from both resume
  PDFs. Two resume variants matching the two real resumes, not a third one
  invented for symmetry. `englishLevel`, `minimumStipend` and
  `maxWeeklyHours` carry the `⚠ VERIFY` placeholder, genuinely unanswered.

### Fixed — timezone-dependent academic period

- `computeAcademicPeriod`'s first implementation used `Date#getMonth()` and
  `Date#getFullYear()`, which read the process's local timezone. The mandated
  July-boundary regression test failed under this sandbox's
  America/Sao_Paulo clock: the same course-start date would silently compute
  a different period depending on whether the deploying process runs as
  America/Sao_Paulo or as UTC — the default in most Docker base images, and
  M8 deploys this in a container. Switched to the UTC getters; verified
  identical results under both America/Sao_Paulo and `TZ=UTC`.

### Added — M1, domain and stage C

- `Posting` and `RawPosting` as distinct types (`src/posting/domain/`), with
  `createPosting` enforcing the invariants from `docs/05-domain-model.md` at
  construction — non-empty company/title/source/sourceId, a fingerprint
  derived rather than supplied.
- Fingerprint as a pure, unit-tested function: lowercase, strip accents, strip
  punctuation, collapse whitespace, sha256. Documented, not silently patched:
  punctuation stripping without a space means a hyphenated title fingerprints
  differently from its spaced form — the known gap layer 2 similarity exists
  to catch.
- Stage C (`computeScore`) as a pure function covering the full formula: per-
  weight coverage with the empty-category rule, the blocking cap (`partial`
  blocks same as `not_met`, and the cap never raises an already-low score),
  `lowConfidence` capping the verdict at `review` without ever upgrading a
  `discard`, `trackAlignment` with highest-weight-wins on multi-track
  postings, and `criticalGaps`.
- `CollectorPort`, `ScorerPort` (ADR-006's typed failure result) and
  `NotifierPort`, all returning failure as a value, never throwing.
- A NestJS skeleton that actually boots: `npm run build && npm run start`
  produces a real `AppModule dependencies initialized` log line, not just a
  passing typecheck.
- `test/typescript-metadata.test.ts` — a permanent regression check for
  `emitDecoratorMetadata` plus Nest's DI container, added to make the
  TypeScript 7 reassessment answerable.
- `dev`, `build` and `start` scripts, deferred from M0 because there was no
  entry point for them to run.

### Changed

- `npm test` no longer carries `--passWithNoTests` — the project has real
  tests now.
- `tsconfig.json` gained an explicit `"types": ["node"]`. It was previously
  working by accident: `@types/node` was only being pulled in transitively
  through `vitest.config.ts` and the test files being part of the compiled
  set, which broke silently the moment `tsconfig.build.json` excluded both.
- ADR-002 gained Amendment 2: TypeScript 7 was reassessed with real Nest code
  in place. The original concern — decorator metadata under the native-port
  compiler — turned out to be unfounded; typecheck, build, a real compiled
  boot and the full test suite all pass under 7.0.2. The actual blocker is
  that `typescript-eslint` refuses to run under TS 7.0 at all. Staying on
  6.0.3, for a different and now better-understood reason.

### Added — foundations

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

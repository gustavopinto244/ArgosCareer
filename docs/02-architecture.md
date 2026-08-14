# 02 — Architecture

## Pipeline

```
Scheduler
   │
   ├─► Collect        adapters per source, never throw
   │      ▼
   │   Normalize      one shape, regardless of source
   │      ▼
   │   Dedup          fingerprint, then similarity
   │      ▼
   │   Pre-filter     deterministic, cuts ~70%
   │      ▼
   │   Score          stage A + B (LLM), stage C (code)
   │      ▼
   └─► Deliver        Telegram digest
          ▼
       Feedback       Phase 2, not v1
```

Each box is a stage with a persisted boundary on either side. That is what makes
principle 2 below achievable rather than aspirational.

## The four principles

These are tie-breakers. When a design question has no obvious answer, the
principle that applies decides it, and the reasoning goes in an ADR.

### 1. A broken source does not bring down the pipeline

A collector **never** propagates an exception. It returns:

```ts
type CollectionResult = {
  source: string;
  postings: RawPosting[]; // empty on failure
  error?: CollectionError; // set on failure
  collectedAt: Date;
};
```

Gupy changing a field name must degrade that night's digest, not cancel it. The
consequence to accept: a silently empty source looks identical to a source with
no matching postings, so M8 adds an alert on a source returning zero results
across consecutive runs. Without that alert this principle hides failures instead
of surviving them.

### 2. Every stage is independently re-runnable

Running scoring over already-collected postings, without re-collecting, is a
requirement. Prompt iteration during M7 is impossible otherwise: 50 postings
re-collected on every prompt tweak is both slow and rude to the source.

This forces every stage boundary to be persisted, not held in memory, and forces
stages to be idempotent — re-running one must not duplicate rows or re-notify.

### 3. Profile and criteria are data, not code

Changing search strategy — a new blocked title, a different city, a new
competency — must not require touching the application. Profile lives in
`config/profile.yaml`, filter rules in configuration, both validated with Zod at
load time.

The consequence to accept: configuration errors become runtime errors rather than
compile errors, which is why validation must fail loudly at startup rather than
producing an empty filter that silently passes everything.

### 4. The LLM engine is a replaceable detail

Swapping a local model for an API is a configuration change, not a refactor. This
is what makes the `StubScorer` → `ApiScorer` → `OllamaScorer` progression
possible, and it is why stage C contains no LLM call at all.

## Ports

Three, all defined in the domain layer, all implemented in infrastructure:

| Port            | Contract                                                       | Adapters                                                                                                                         |
| --------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `CollectorPort` | `collect(criteria): Promise<CollectionResult>` — never rejects | `GupyCollector` (M3), `JobSpyCollector` (post-M6), `LinkedInCollector` (post-M6), `N8nCollector` for long-tail sources (ADR-008) |
| `ScorerPort`    | `score(posting, profile): Promise<ScoreResult>`                | `StubScorer` (M1), `ApiScorer` (M7), `OllamaScorer` (M7)                                                                         |
| `NotifierPort`  | `notify(digest): Promise<void>`                                | `TelegramNotifier` (M6)                                                                                                          |

NestJS's DI container is what makes this cheap: a port is an injection token, an
adapter is a provider, and swapping them is a module change. That is the reason
for choosing Nest over plain Express (ADR-001).

Layering follows `atlas-manager`: `domain/` holds entities and ports with no
framework imports, `application/` holds use cases, `infrastructure/` holds
adapters, `composition/` wires them.

## Scheduling and cadence

Two independent schedules, deliberately different in frequency and in cost
(ADR-009):

**Collection runs frequently — every few hours, low volume, no LLM.** It
collects, normalizes, deduplicates and pre-filters. None of that needs a model,
so none of it is confined to a time window.

**Scoring and delivery run once nightly**, in a configured off-peak window
(default `03:00 America/Sao_Paulo`). This is the only window in which the LLM
runs, the only point where `OLLAMA_KEEP_ALIVE=0` matters, and the only time the
digest is delivered — **daily**, not twice a week.

Reasoning:

- Frequent, low-volume collection still looks like a person checking a job
  board rather than a burst, which is what rate limiting is designed to catch.
  Running it every few hours instead of once a day only improves this.
- A posting appearing at 9am is now discovered within a few hours and delivered
  that same night — worst case, once nightly. Under the old twice-weekly
  digest, a posting appearing right after Friday's send waited until the
  following Tuesday. **This is a strict latency improvement, not only a
  resource optimization.**
- Confining the LLM to one nightly window means the model loads once, runs one
  bounded batch, and unloads — instead of contending with `atlas-manager`,
  Nginx and the other Atlas services during hours when they are actually
  serving traffic.
- `firstSeenAt` (ADR-007 amendment) is now accurate to within the collection
  interval rather than to within a day, which matters once M10's market
  analysis reads it.

Implemented with `@nestjs/schedule`, as two independent cron jobs. Both
intervals — collection frequency and the nightly window's time and timezone —
are configuration (`docs/09-configuration.md`).

## Deduplication

Two layers, because one is not enough.

**Layer 1 — deterministic fingerprint.**

```
fingerprint = sha256(normalize(company) + normalize(title) + normalize(city))

normalize(s) = s
  |> lowercase
  |> strip accents (NFD, drop combining marks)
  |> strip punctuation
  |> collapse whitespace
```

Catches the common case: the same posting re-collected on consecutive days, or
appearing on two sources.

**Layer 2 — textual similarity** between postings from the same company within
the same time window. Catches what layer 1 cannot: "Estágio em Back-end" and
"Estagiário Backend (Rio de Janeiro)" from the same company are the same job with
different fingerprints.

A posting already seen is **never reprocessed and never re-notified** — this is
both a cost control (stage A and B are the expensive stages) and a usability
requirement (criterion 2 in `01-vision-and-scope.md`).

Detail deferred to M4, where it will get its own ADR alongside the schema that
implements it.

## Pre-filter

Deterministic rules, run **before** any LLM call. This cuts roughly 70% of
collected postings and is the single thing that makes a local model viable — the
difference between scoring 200 postings and scoring 60 is the difference between
a batch that finishes and one that gets killed.

| Rule                      | Behavior                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| Title blocklist           | `sênior`, `senior`, `pleno`, `especialista`, `coordenador`, `gerente`, `tech lead`, `III`, `IV` |
| Title requirement         | Must match `estágio` / `estagiário` / `intern` / `trainee`                                      |
| Location                  | Rio de Janeiro + metropolitan region, or remote                                                 |
| Blocked companies         | Configurable list                                                                               |
| Expired                   | Closed or past application deadline                                                             |
| Minimum keyword adherence | Must hit a floor of profile keywords before spending LLM budget                                 |

All rules are configuration (principle 3). Rules and thresholds get an ADR in M5.

**Ordering note:** the pre-filter runs after dedup, not before. Dedup is cheaper
than filtering and shrinks the input to every later stage.

## Scoring

Summarized here; the reasoning lives in `04-scoring-model.md` and ADR-005.

| Stage          | Runs on  | Cacheable by            | Output                                       |
| -------------- | -------- | ----------------------- | -------------------------------------------- |
| A — Extraction | LLM      | posting                 | `{text, category, weight}[]`                 |
| B — Matching   | LLM      | (posting, profile hash) | `met \| partial \| not_met` + evidence quote |
| C — Score      | **code** | —                       | number, verdict, gaps                        |

Stage C is a pure function: no I/O, no LLM, deterministic, unit-tested. The LLM
never emits the number.

## Academic period derivation

Derived at runtime from the course start date in `config/profile.yaml`. **Never
hardcoded** — a fixed period is correct for at most six months and then becomes a
silent lie that produces wrong filtering.

Count **academic semester boundaries**, not elapsed months. In the Brazilian
calendar the first semester begins around March and the second around August, so
naive month arithmetic gets March→August (5 months) wrong: it yields period 1
when it is already period 2.

```
absoluteIndex(year, month) = year * 2 + (month >= 7 ? 1 : 0)
period = absoluteIndex(today) - absoluteIndex(courseStart) + 1
```

**`month` is 1-indexed in that formula. `Date.getMonth()` is 0-indexed**, so
written against it the boundary must be `>= 6`. Getting this wrong is off by a
full semester, in the direction that makes postings look reachable when they are
not.

Worked example, using the real course start of March 2026:

| Date                | `absoluteIndex`     | Period |
| ------------------- | ------------------- | ------ |
| March 2026 (start)  | `2026×2 + 0` = 4052 | 1      |
| August 2026         | `2026×2 + 1` = 4053 | **2**  |
| March 2027 (2027.1) | `2027×2 + 0` = 4054 | **3**  |

Clamp the result to `[1, 8]` and handle dates before the start date explicitly.

Implemented in M2 with unit tests pinning both boundary cases above, since those
are exactly the values the off-by-one error would break.

**Product consequence:** postings blocked only by minimum period go into a
separate digest section — "opens for you in 2027.1" — instead of being discarded.

## Delivery

A **direct, dumb Telegram client.** No framework, no agent, no dependency on
anything else running. The digest is the product; if it does not arrive, nothing
else in this document matters.

Digest text is pt-BR (ADR-003). Sections:

1. Recommended (`apply`)
2. Worth reviewing (`review`)
3. Opens for you in `<term>` — period-blocked
4. Run summary: collected, deduped, filtered, scored, and any source that failed

Section 4 is what makes principle 1 honest: a source that failed is visible in
the digest rather than silently absent.

### Per-posting message

Each entry carries enough to decide **without opening the posting** — that is the
whole point of the under-10-minutes goal:

```
Empresa: Empresa X
Cargo: Estágio em Desenvolvimento Backend
Compatibilidade: 84% · candidatar
Local: Rio de Janeiro · Remoto
Fonte: Gupy
Requisitos: Node.js, TypeScript, PostgreSQL, Docker

Pontos fortes: TypeScript, APIs REST e PostgreSQL têm evidência no perfil.
Lacunas: Docker aparece como requisito e está pouco representado.
Currículo recomendado: Backend
Sugestão: destacar o Atlas Manager e experiências com APIs e infraestrutura.

→ <link para a vaga original>
```

Every line is derived, not written by a model:

| Line                  | Comes from                                               |
| --------------------- | -------------------------------------------------------- |
| Compatibilidade       | Stage C score and verdict                                |
| Pontos fortes         | Matches with status `met`, and their evidence            |
| Lacunas               | `criticalGaps` and `missingTerms`                        |
| Currículo recomendado | Variant overlap — a pure function (`05-domain-model.md`) |
| Sugestão              | Emphasis rules over evidence already in the profile      |

**Nothing here is generated prose.** Producing resume text, cover letters or
recruiter messages is Phase 3 and out of v1 (`01-vision-and-scope.md`). The
digest selects and ranks what already exists.

The original posting link is mandatory on every entry. A digest that cannot be
acted on immediately is a digest that gets postponed.

## Hermes boundary

ArgosCareer exposes a stable HTTP API, and later an MCP server (M9). Hermes Agent
is a **consumer, never the critical path.**

The pipeline is not implemented as a Hermes skill. That would be faster and would
destroy the project: the core would become configuration of a third-party tool,
leaving no reviewable code of its own, coupled to a v0.x project that ships every
two weeks. See `CLAUDE.md` §10.

The nightly digest works with Hermes down. That is the test of whether the
boundary is real.

## Deployment and resource budget

Atlas: mini PC, Ubuntu Server, 7.1 GB RAM, no GPU. Measured at rest: 1.0 GB used,
6.1 GB available, 4 GB swap untouched. Already running `atlas-manager`, Nginx,
cloudflared and two Docker containers.

**Budget: ~150 MB at rest, ~250 MB at peak.**

| Constraint                       | Requirement                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Ollama peaks ~3.2 GB             | **`OLLAMA_KEEP_ALIVE=0`** so the model unloads at end of batch                     |
| Swap is an OOM net, not headroom | Paging during inference destroys latency; a plan that relies on swap is not a plan |
| P1 sources                       | Ephemeral Python container (`--rm`), prints JSON and exits — zero RAM at rest      |
| n8n, if adopted (ADR-008)        | **Unmeasured footprint**, plausibly larger than the whole application budget       |

Docker Compose, M8.

The n8n line is the one to watch. It sits outside the ArgosCareer budget as a
separate container, and if it does not fit alongside `atlas-manager`, Nginx,
cloudflared and the existing containers, ADR-008's inbound half is dropped and
the outbound half — which can run anywhere — survives. Measured in M8, not
assumed now.

## Collector etiquette

Required of every adapter, without exception:

- `robots.txt` respected
- ~1.5 s between requests
- An **honest `User-Agent`** identifying what the client is — never forged to
  imitate a browser
- Exponential backoff on failure
- Explicit timeout on every request

A discreet collector is a collector that keeps working. A forged User-Agent is
also the thing that turns "personal automation" into "misrepresentation" if it is
ever examined.

**Non-negotiable:** no collector is ever authenticated with a personal LinkedIn
session or cookies. See `CLAUDE.md` §3.

## Verified: the Gupy response shape (M3)

Was listed below as unverified through M0–M2. `npm run fixture:gupy` captured
the real response from `https://employability-portal.gupy.io/api/v1/jobs`
on 2026-08-14 — public, JSON, no auth, exactly as hoped, confirmed rather than
assumed.

```
GET https://employability-portal.gupy.io/api/v1/jobs
  ?jobName=<free text>&city=<text>&type=<vacancy_type_*>
  &isRemoteWork=<bool>&limit=<n>&offset=<n>

200 { data: JobItem[], pagination: { total, limit, offset } }
```

`jobName`, `city`, `type` and `isRemoteWork` all filter server-side — verified
against the live endpoint, not guessed from the shape of the URL. This
matters: it means the pre-filter in M5 does not have to fetch everything and
discard most of it, because the search itself can be narrowed at the source.

`JobItem` carries `id`, `name`, `companyId`, `careerPageName` (the employer's
display name), `city`/`state`/`country`, `workplaceType`
(`remote`/`hybrid`/`on-site`), `isRemoteWork`, `type` (an open string — four
distinct values turned up in a small sample, evidence there are more, not a
closed set), `publishedDate`, `applicationDeadline`, and an optional `badges`
object present on some items and entirely absent — not null — on others.
`skills` was an empty array on every item observed; no non-empty example
exists anywhere in this project's fixtures because none has been seen.

Full schema: `src/posting/infrastructure/gupy-schema.ts`. Provenance for the
curated, committed sample: `test/fixtures/gupy-jobs.md`.

**`robots.txt` checked on both `employability-portal.gupy.io` and `gupy.io`
— neither exists (404).** Nothing to respect because nothing is declared;
recorded here rather than left as a silent gap in the polite-collector
checklist.

## Unverified assumptions

Recorded so they are not mistaken for facts.

| Assumption                                             | Status                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| A 4B local model is accurate enough for stages A and B | **Unverified.** Decided by the M7 benchmark, not in advance |
| The pre-filter cuts ~70%                               | **Estimate.** Measured in M5 against real collected volume  |
| ~150 MB at rest fits alongside current Atlas load      | **Estimate.** Verified in M8 under real load                |

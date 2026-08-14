# ArgosCareer

Collects internship postings, scores them against a master profile, and delivers
a ranked digest to Telegram twice a week.

Personal project. Built to cut weekly job-triage time to under 10 minutes, and to
be honest about what it can and cannot tell you.

> **Status: M0 — bootstrap.** Documentation and CI are in place. No pipeline code
> yet. Milestone table below.

## What it answers

|       | Question                                              | Status                          |
| ----- | ----------------------------------------------------- | ------------------------------- |
| **1** | Which are the best postings for me right now?         | v1                              |
| **2** | What do I need to improve to be a better candidate?   | after calibration               |
| **3** | How should I present my profile for this opportunity? | v1 — recommends, does not write |

It starts as a job radar and grows into a career assistant driven by real market
data: the same corpus that ranks postings is what later says which skills the
market actually asks for, and which of them your profile cannot yet evidence.

## The problem

Searching for an internship means opening the same job boards every few days,
reading the same postings twice because nothing remembers what was already seen,
and rejecting the same senior roles a keyword filter keeps matching. The work is
not hard, it is repetitive — and the cost of postponing it is invisible until a
posting closes.

The bottleneck is finding and triaging postings, not applying to them.

## How it works

```
Scheduler → Collect → Normalize → Dedup → Pre-filter → Score → Telegram digest
           (every 4h)                  (84-97% cut)  (LLM, nightly, off-peak)
```

Collection runs every few hours, low volume, no LLM; scoring and delivery run
once nightly in an off-peak window (ADR-009). The digest goes out daily.
Decoupling the two shortens the discovery window from days to hours and keeps
request patterns unremarkable.

A deterministic pre-filter runs before any LLM call. Measured against real
collected data, it cuts 84-97% of postings up front depending on how narrowly
collection is targeted — this is what makes a 4B model on a GPU-less mini PC
viable at all.

### Scoring: the LLM does not produce the number

The obvious design — send resume and posting to a model, ask for a score out of
100 — fails three ways. It is not calibrated (almost everything lands between 65
and 85), it is not comparable across prompt versions, and holistic numeric
judgment is exactly where a small model diverges most from a large one.

So the model is given only the two jobs it is good at, and the arithmetic happens
in code:

| Stage              | Runs on  | Produces                                                         |
| ------------------ | -------- | ---------------------------------------------------------------- |
| **A — Extraction** | LLM      | Structured requirements: `{text, category, weight}`              |
| **B — Matching**   | LLM      | `met \| partial \| not_met`, **with a mandatory evidence quote** |
| **C — Score**      | **code** | A pure, deterministic, unit-tested number                        |

```
score = 65 × mandatoryCoverage + 20 × desirableCoverage + 15 × trackAlignment
```

The evidence quote is load-bearing. Without it the model hallucinates adherence —
it _wants_ to agree that you qualify, and with no obligation to point at anything
in your profile, it will. Requiring a verbatim quote turns an agreeable judgment
into a retrieval task with a checkable answer. `evidence: null` forces `not_met`,
enforced in code rather than requested in the prompt.

A failed knockout requirement caps the score at 35 — `partial` included, because
an ATS knockout question is binary.

Full model, thresholds and reasoning: [`docs/04-scoring-model.md`](docs/04-scoring-model.md)
and [ADR-005](docs/adr/005-llm-does-not-produce-the-score.md).

### What it honestly does not do

**This is not an ATS simulator.** Gupy ranks candidates with a proprietary,
opaque system, and no external project reproduces it.

The question this answers reliably is narrower:

> Does my resume demonstrate evidence for what this posting declares it wants?

Postings also lie by omission and copy boilerplate between roles, so the system
scores declared text, not the actual job. Every weight and cutoff above is
provisional until the M7 calibration.

### Calibration

Planned for M7 and not yet run: 50 real postings labelled by hand, then measured
correlation and verdict precision/recall, varying one thing at a time — model,
prompt, weights, cutoffs. **The results table will be published here, including
the configurations that lost.**

A scoring system that has never been measured against ground truth is a number
generator. Until this table exists, treat the scores as a plausible hypothesis
with a formula behind it.

## Stack

TypeScript · NestJS · Zod · Pino · Drizzle ORM + SQLite · Vitest + Supertest ·
Docker Compose · GitHub Actions

Deployed to a self-hosted Ubuntu Server mini PC (7.1 GB RAM, no GPU) within a
~150 MB at-rest budget, alongside services already running there.

Next.js was rejected: it is a UI framework and v1 is a headless batch service.
See [ADR-001](docs/adr/001-nestjs-as-application-framework.md).

## Milestones

| #   | Milestone                                                        | Status |
| --- | ---------------------------------------------------------------- | ------ |
| M0  | Bootstrap — docs, CI, ADR practice, repository hygiene           | done   |
| M1  | Domain entities, fingerprint, score computation (stage C)        | done   |
| M2  | Master profile — Zod schema, loader, academic-period derivation  | done   |
| M3  | Gupy collector with tolerant schema + fixture capture script     | done   |
| M4  | Persistence — Drizzle + SQLite, migrations, dedup                | done   |
| M5  | Deterministic pre-filter                                         | done   |
| M6  | **Vertical slice** — Gupy → SQLite → Telegram with a stub scorer | done   |
| M7  | Real scoring — stages A and B, versioned prompts, calibration    |        |
| M8  | Deployment — Docker Compose, scheduling, backup, alerting        |        |
| M9  | HTTP API and MCP server                                          |        |
| M10 | Market intelligence — skill taxonomy, gap analysis, study plan   |        |

## Documentation

|                                                                    |                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| [`CLAUDE.md`](CLAUDE.md)                                           | Full project context and working agreement            |
| [`docs/01-vision-and-scope.md`](docs/01-vision-and-scope.md)       | Goals, non-goals, success criteria, honest limits     |
| [`docs/02-architecture.md`](docs/02-architecture.md)               | Pipeline, principles, ports, cadence, resource budget |
| [`docs/03-technical-decisions.md`](docs/03-technical-decisions.md) | ADR index and when an ADR is required                 |
| [`docs/04-scoring-model.md`](docs/04-scoring-model.md)             | The scoring model in full                             |
| [`docs/05-domain-model.md`](docs/05-domain-model.md)               | Entity boundaries and invariants                      |
| [`docs/06-glossary.md`](docs/06-glossary.md)                       | Domain vocabulary and the code/digest translation     |
| [`docs/07-testing-strategy.md`](docs/07-testing-strategy.md)       | Test levels, and the curated-fixture workflow         |
| [`docs/08-observability.md`](docs/08-observability.md)             | Logging, run records and alerting                     |
| [`docs/09-configuration.md`](docs/09-configuration.md)             | Secrets, profile and criteria                         |
| [`docs/10-milestones.md`](docs/10-milestones.md)                   | Acceptance criteria per milestone                     |

## Development

```bash
npm ci
npm run lint && npm run format:check && npm run typecheck && npm test
```

CI runs all four on Node 22 and 24. `main` is protected; work happens on a
branch per milestone and lands by squash merge with green CI.

The master profile (`config/profile.yaml`), the postings database and raw API
captures are gitignored — this repository is public and they contain personal
data. A structural example with fictional data ships in M2. The full boundary is
[ADR-004](docs/adr/004-public-repository-privacy-boundary.md).

## A note on collection

Every collector respects `robots.txt`, spaces requests ~1.5 s apart, identifies
itself with an honest `User-Agent` that is never forged to imitate a browser,
backs off exponentially and times out explicitly.

No collector is ever authenticated with a personal LinkedIn session or cookies.
Losing that account during an internship search would cost far more than anything
collecting from it could provide.

## License

MIT

# 01 — Vision and scope

## The problem

Searching for an internship means opening the same five job boards every few
days, reading the same postings twice because nothing remembers what was already
seen, and repeatedly rejecting senior roles that a keyword filter matched. The
work is not hard. It is repetitive, easy to postpone, and the cost of postponing
it is invisible until a posting closes.

The bottleneck is **finding and triaging** postings, not applying to them. That
framing decides most of the scope below.

## The three questions

In the long run the system answers three questions automatically. They are the
spine of the roadmap, and every module exists to answer one of them.

|       | Question                                                       | Answered by                                                      |
| ----- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| **1** | Which are the best postings for me right now?                  | Radar — collect, dedup, score, digest                            |
| **2** | What do I need to improve to become a better candidate?        | Market intelligence and gap analysis over the accumulated corpus |
| **3** | How should I present my profile for this specific opportunity? | Resume recommendation and keyword gaps                           |

Question 1 is v1. Questions 2 and 3 are what the stored data makes possible, and
they are the reason the database is a **corpus**, not a cache — see
_Evolution_ below.

## Goals

**Primary — cut weekly triage time to under 10 minutes.**

Measurable: time spent, from opening the digest to having a shortlist worth
acting on. If the system produces a ranked list that still needs an hour of
reading, it has failed even if every component works.

**Secondary — be a portfolio centerpiece.**

The project should demonstrate layered architecture, LLM integration under real
resource constraints, persistence, scheduling, and deployment on self-hosted
infrastructure. This goal is real, not decorative: it justifies effort on ADRs,
tests and documentation that a purely personal tool would not repay.

The two goals mostly agree. Where they conflict, the primary goal wins — a
beautifully documented system that does not save time is a failure with good
paperwork.

## Search profile

|                |                                                                |
| -------------- | -------------------------------------------------------------- |
| **Priority 1** | Back-end development **and** information security internships  |
| **Priority 2** | Infrastructure / automation                                    |
| **Location**   | Rio de Janeiro and metropolitan region, or remote              |
| **Level**      | Internship only — `estágio`, `estagiário`, `intern`, `trainee` |

Back-end and security are **equal** first priorities. Both resumes are real
positions, not a primary and a fallback, and the search should not quietly
demote one of them.

Track membership drives the `trackAlignment` term in the score
(`docs/04-scoring-model.md`) and the `dev` / `security` / `automation` tags in the
master profile. The equal priority is expressed as `dev` and `security` sharing
the same weight, not as a special case in the formula.

**Internship only — junior and entry-level roles are deliberately out.** This was
reconsidered when the product vision was expanded and kept as it was. The reason
to widen would be a bigger funnel; the reasons not to, which won:

- The primary goal is _less_ time triaging. Doubling the funnel to surface roles
  that mostly will not hire someone in their second period works against it.
- Junior postings expect delivered professional experience. Scoring them against
  a profile that has none produces a stream of 40s — noise that makes the digest
  worse, not richer.
- Nothing is lost permanently. The corpus keeps every collected posting including
  rejected ones, so widening later is a filter change plus a re-run, not a
  re-collection.

Revisit when the academic period reaches 4, or when the digest is consistently
short. Both are observable, not guesses.

## Non-goals

Each of these looks useful and is deliberately excluded. Reopening one requires
an ADR, not a preference.

| Out of scope                         | Reason                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Automatic job application            | Ban risk on the platforms that matter, and it optimizes the wrong step — the bottleneck is finding the posting |
| **Generating** resume or letter text | See the distinction below. Recommending is in; writing is Phase 3                                              |
| Junior / entry-level roles           | Reasoned above under _Search profile_                                                                          |
| Web interface                        | Telegram is the interface in v1. A UI is where this kind of project quietly dies                               |
| Multi-user / SaaS                    | Personal product. Auth, tenancy and LGPD compliance with no upside                                             |
| Scraping at scale                    | Not what this is for, and directly at odds with the polite-collector rules                                     |
| n8n as pipeline orchestrator         | The core would become third-party configuration. ADR-008 places it where it belongs instead                    |

### Recommending a resume vs. generating one

These look like one feature and are not. The line matters enough to draw it here.

**In scope (question 3):** given a posting, say **which existing resume version
fits best**, which experiences to foreground, and which posting terms are absent
from the profile. This is almost free — it reuses `missingTerms` and
`trackAlignment`, which the scoring model already produces. Nothing is written;
material that already exists is selected and ranked.

**Out of scope (Phase 3):** producing resume prose, cover letters, recruiter
messages or application-form answers. That is a module with its own failure mode
— a model writing about your experience will eventually write something you did
not do, and the cost of that lands in an interview.

The governing rule for both, now and later: **never invent experience or
competence.** The system rearranges emphasis on what is already in the profile.
That rule is why the scoring model demands a verbatim evidence quote, and it
extends unchanged to anything Phase 3 adds.

## Success criteria

v1 is done when all of these hold:

1. A digest arrives on Telegram every Tuesday and Friday without manual action.
2. A posting already seen is never shown twice.
3. Triage from digest to shortlist takes under 10 minutes.
4. One source failing degrades the digest instead of stopping it.
5. Score computation is deterministic and unit-tested — the same inputs give the
   same number, forever.
6. The calibration table is published in the README, with the measured
   correlation between the model's score and hand-labelled scores.

Criterion 6 is the one that distinguishes this from any job aggregator on GitHub.
A scoring system that has never been measured against ground truth is a number
generator.

## Honest limits

This is **not an ATS simulator.** Gupy ranks candidates with a proprietary,
opaque system, and no external project can reproduce it. Claiming otherwise in
the README, in a commit message, or in an interview would be a lie that is easy
to check.

The question this system answers reliably is narrower and still useful:

> Does my resume demonstrate evidence for what this posting declares it wants?

Everything downstream — the score, the verdict, the gap list — is an answer to
that question and should be described as such.

Two further limits worth stating:

- **Requirements are extracted from posting text.** Postings lie by omission,
  copy boilerplate between roles, and hide real requirements in the interview.
  The system scores the declared text, not the actual job.
- **Weights and cutoffs are provisional** until the M7 calibration. Until then,
  every score is a plausible guess with a formula behind it.

## Open questions

These block nothing today but will produce wrong results if they stay unanswered.
They are marked `⚠ VERIFY` in `config/profile.yaml`.

| Field                    | Why it matters                                                                                                                                                                                | Status     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **English level**        | A frequent knockout requirement, and absent from both resumes. Without it, stage B has no evidence to cite and every English requirement scores `not_met` — deflating scores across the board | Unanswered |
| **Minimum stipend**      | Pre-filter criterion. Without it, postings that are non-viable in practice consume LLM budget                                                                                                 | Unanswered |
| **Maximum weekly hours** | Same, and interacts with class schedule                                                                                                                                                       | Unanswered |

The English-level gap is the most damaging of the three: it does not merely miss
a filter, it systematically biases the score downward, which would corrupt the
M7 calibration if left unresolved before labelling begins.

## Academic period as a scoping constraint

Systems Information, starting March 2026, expected completion December 2029.
This produces a constraint no keyword filter would catch: as of 2026.2 the
current period is **2**, reaching 3 in 2027.1. Many internships require "3rd
period onward", and some cap expected graduation at 2028 — both ends can block.

The digest therefore separates period-blocked postings into **their own section**
("opens for you in 2027.1") rather than discarding them. Knowing that a company
hires interns and when its bar becomes reachable is planning information.

Derivation rule and its off-by-one trap: `docs/02-architecture.md`.

## Evolution

The system is built as a radar and grows into a data-driven career assistant. The
chain, in dependency order:

```
Radar → Opportunity corpus → Compatibility scoring → History
      → Market analysis → Gap analysis → Study plan
      → Resume recommendation → Personalized communication
```

Each link needs the one before it, which is why the order is not negotiable: gap
analysis over an uncalibrated score would produce a study plan built on noise.

**What this requires from the start**, even though the later links are far off:

- **The database is a corpus, not a cache.** Every collected posting is retained,
  including the ones the pre-filter rejected — "which companies hire most" and
  "which regions have most openings" need everything, not just what survived
  filtering.
- **Postings carry `firstSeenAt` and `lastSeenAt`.** Market evolution over time is
  unanswerable without them, and they cannot be reconstructed after the fact.
- **New sources plug in without touching the core.** `CollectorPort` plus, for
  long-tail sources, ADR-008.

Question 2 depends on one thing that does not exist yet and is not free: a
**global skill taxonomy**. "PostgreSQL appears in 58% of relevant postings" only
holds if `Postgres`, `PostgreSQL` and `postgre` collapse into one canonical
term. The profile's per-competency `aliases` are the wrong tool — they describe
_this_ profile, so counting with them measures only what is already known. The
taxonomy is built in M10, over the accumulated corpus.

### Phases beyond v1

Recorded so they stay out of v1, not as commitments.

- **Phase 2 — Feedback.** Record what was applied to and what got a response, and
  feed that back into weighting.
- **Phase 3 — Generated communication.** Resume prose, cover letters, recruiter
  messages, application-form answers. Possibly a dashboard, reconsidered on its
  merits at that point rather than assumed now.

# 01 — Vision and scope

## The problem

Searching for an internship means opening the same five job boards every few
days, reading the same postings twice because nothing remembers what was already
seen, and repeatedly rejecting senior roles that a keyword filter matched. The
work is not hard. It is repetitive, easy to postpone, and the cost of postponing
it is invisible until a posting closes.

The bottleneck is **finding and triaging** postings, not applying to them. That
framing decides most of the scope below.

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

| | |
|---|---|
| **Priority 1** | Back-end development internships |
| **Priority 2** | Information security, infrastructure / automation |
| **Location** | Rio de Janeiro and metropolitan region, or remote |
| **Level** | Internship only — `estágio`, `estagiário`, `intern`, `trainee` |

Track membership drives the `trackAlignment` term in the score
(`docs/04-scoring-model.md`) and the `dev` / `security` / `automation` tags in the
master profile.

## Non-goals

Each of these looks useful and is deliberately excluded. Reopening one requires
an ADR, not a preference.

| Out of scope | Reason |
|---|---|
| Automatic job application | Ban risk on the platforms that matter, and it optimizes the wrong step — the bottleneck is finding the posting |
| Per-posting resume generation | A meaningful project on its own; deferred to Phase 3 so it does not swallow v1 |
| Web interface | Telegram is the interface in v1. A UI is where this kind of project quietly dies |
| Multi-user / SaaS | Personal product. Auth, tenancy and LGPD compliance with no upside |
| Scraping at scale | Not what this is for, and directly at odds with the polite-collector rules |

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

| Field | Why it matters | Status |
|---|---|---|
| **English level** | A frequent knockout requirement, and absent from both resumes. Without it, stage B has no evidence to cite and every English requirement scores `not_met` — deflating scores across the board | Unanswered |
| **Minimum stipend** | Pre-filter criterion. Without it, postings that are non-viable in practice consume LLM budget | Unanswered |
| **Maximum weekly hours** | Same, and interacts with class schedule | Unanswered |

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

## Phases beyond v1

Recorded so they stay out of v1, not as commitments.

- **Phase 2 — Feedback.** Record what was applied to and what got a response, and
  feed that back into weighting.
- **Phase 3 — Resume tailoring.** Use `missingTerms` to propose per-posting
  resume adjustments. Possibly a Next.js dashboard, reconsidered on its merits at
  that point.

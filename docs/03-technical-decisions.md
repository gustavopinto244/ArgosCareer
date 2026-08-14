# 03 — Technical decisions

Every non-obvious decision in this project becomes an Architecture Decision
Record in `docs/adr/`. This page is the index and the rules.

The practice is carried over from `atlas-manager`, where 35 ADRs turned out to be
the most useful thing in the repository — not because decisions get made better,
but because six months later the reasoning is still there and a decision can be
revisited on its merits instead of re-argued from memory.

## Index

| ADR                                                  | Title                                                        | Status   | Date       |
| ---------------------------------------------------- | ------------------------------------------------------------ | -------- | ---------- |
| [001](adr/001-nestjs-as-application-framework.md)    | Use NestJS as the application framework                      | Accepted | 2026-08-14 |
| [002](adr/002-commonjs-module-system.md)             | Build on CommonJS with a strict TypeScript configuration     | Accepted | 2026-08-14 |
| [003](adr/003-english-repository-language.md)        | Write the repository in English, deliver the digest in pt-BR | Accepted | 2026-08-14 |
| [004](adr/004-public-repository-privacy-boundary.md) | Draw an explicit privacy boundary for a public repository    | Accepted | 2026-08-14 |
| [005](adr/005-llm-does-not-produce-the-score.md)     | Keep score computation out of the LLM                        | Accepted | 2026-08-14 |
| [006](adr/006-llm-output-failure-policy.md)          | Treat invalid LLM output as a normal outcome                 | Accepted | 2026-08-14 |

## When an ADR is required

Write one when a decision is **non-obvious and costly to reverse**. In practice:

- Choosing between viable alternatives, where the loser had real merit
- Anything that constrains later work — a module system, a schema, a boundary
- Deviating from a convention this project or `atlas-manager` already follows
- Accepting a known trade-off, so the cost is recorded rather than rediscovered
- Rejecting something that looks like an obvious improvement, so it does not get
  re-proposed every few months

Do **not** write one for a decision with no real alternative, a choice that is
free to reverse, or a preference. A repository of ADRs recording that Prettier
uses two spaces is a repository where nobody reads the ADRs.

## Rules

**An ADR ships in the same commit as the code that implements it.** A decision
record written afterward is a summary; written alongside, it is the reasoning.

This is why the M0 ADRs cover only the repository itself — framework, module
system, language, privacy boundary, and the scoring architecture that shapes
everything after it. The decisions on deduplication, pre-filter rules, scorer
adapters, persistence schema and the Hermes API boundary are already reasoned
through in `02-architecture.md` and `04-scoring-model.md`, but they become ADRs
in M4, M5, M7 and M9, next to the code that implements them.

**ADRs are immutable once accepted.** A decision that changes gets a new ADR that
supersedes the old one, and the old one is marked `Superseded by ADR-NNN` and
kept. The history of what was believed and when is the point; editing it away
leaves a document that is merely correct.

The exception is **amendment**, when new evidence refines a decision without
reversing it. The amendment is appended, the original text is left untouched, and
the `Status` line points at it. ADR-002 carries a worked example: it was accepted
with `moduleResolution: node16` and later amended to `nodenext` after measuring
that Node supports `require(esm)` unflagged from 22.12.0. The core decision —
CommonJS with a strict configuration — never changed, so it was an amendment
rather than a supersession.

The test for which one applies: if the _Decision_ section would now be wrong,
write a new ADR. If it would only be incomplete, amend.

**Numbering is sequential and never reused**, including for superseded records.

## Format

Copy `adr/000-template.md`. Sections: Status, Date, Context, Considered options,
Decision, Consequences.

Two sections carry most of the value and are the ones usually written badly:

**Considered options** must include the alternatives that were genuinely
plausible, with the reason each was rejected or deferred. An ADR listing one
option and choosing it documents nothing.

**Consequences** must include what the decision makes _harder_, and the cost of
reversing it. A consequences section containing only benefits means the analysis
is not finished.

## Decisions already made, recorded elsewhere

Some constraints are not ADRs because they were never open questions — they are
requirements. They live in `CLAUDE.md` and are listed here so nobody goes looking
for an ADR that does not exist:

- **No collector is ever authenticated with a personal LinkedIn session or
  cookies.** Not a trade-off; a rule.
- **No automatic job application.** A non-goal, with the reasoning in
  `01-vision-and-scope.md`.
- **The pipeline is not implemented as a Hermes skill.** Reasoned in
  `02-architecture.md`; becomes an ADR in M9 when the API boundary is built.
- **Polite collector behavior** — `robots.txt`, request interval, honest
  `User-Agent`, backoff, timeouts. A requirement on every adapter.
